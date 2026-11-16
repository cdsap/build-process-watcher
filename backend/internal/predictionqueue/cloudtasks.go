package predictionqueue

import (
	"context"
	"fmt"
	"log"
	"strings"

	cloudtasks "cloud.google.com/go/cloudtasks/apiv2"
	taskspb "cloud.google.com/go/cloudtasks/apiv2/cloudtaskspb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// CloudTasksConfig configures HTTP task delivery to the prediction job handler.
type CloudTasksConfig struct {
	ProjectID    string
	Location     string
	Queue        string
	TargetURL    string // full URL to POST /internal/prediction-jobs
	AuthToken    string // shared secret header value
	ThrottleMode string // "predict" or "forecast" for dedupe bucket size
}

type taskCreator interface {
	CreateTask(ctx context.Context, req *taskspb.CreateTaskRequest) (*taskspb.Task, error)
	Close() error
}

type cloudTasksAPIClient struct {
	inner *cloudtasks.Client
}

func (c cloudTasksAPIClient) CreateTask(ctx context.Context, req *taskspb.CreateTaskRequest) (*taskspb.Task, error) {
	return c.inner.CreateTask(ctx, req)
}

func (c cloudTasksAPIClient) Close() error {
	return c.inner.Close()
}

// CloudTasks enqueues prediction jobs onto a Cloud Tasks HTTP queue.
type CloudTasks struct {
	client       taskCreator
	queuePath    string
	targetURL    string
	authToken    string
	throttleMode string

	// test hooks
	lastHeaders map[string]string
}

// NewCloudTasks builds a scheduler. Caller must Close when done.
func NewCloudTasks(ctx context.Context, cfg CloudTasksConfig) (*CloudTasks, error) {
	projectID := strings.TrimSpace(cfg.ProjectID)
	location := strings.TrimSpace(cfg.Location)
	queue := strings.TrimSpace(cfg.Queue)
	targetURL := strings.TrimSpace(cfg.TargetURL)
	token := strings.TrimSpace(cfg.AuthToken)
	if projectID == "" || location == "" || queue == "" || targetURL == "" || token == "" {
		return nil, fmt.Errorf("cloud tasks prediction scheduler requires project, location, queue, target URL, and auth token")
	}
	client, err := cloudtasks.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("cloud tasks client: %w", err)
	}
	mode := strings.TrimSpace(cfg.ThrottleMode)
	if mode == "" {
		mode = "predict"
	}
	s := &CloudTasks{
		client:       cloudTasksAPIClient{inner: client},
		queuePath:    fmt.Sprintf("projects/%s/locations/%s/queues/%s", projectID, location, queue),
		targetURL:    targetURL,
		authToken:    token,
		throttleMode: mode,
	}
	log.Printf("🔮 Prediction jobs scheduled via Cloud Tasks queue %s → %s", s.queuePath, s.targetURL)
	return s, nil
}

// Close releases the Cloud Tasks client.
func (s *CloudTasks) Close() error {
	if s == nil || s.client == nil {
		return nil
	}
	return s.client.Close()
}

// Schedule enqueues an HTTP task. AlreadyExists is treated as success (dedupe).
func (s *CloudTasks) Schedule(ctx context.Context, runID string, maxElapsedS int) error {
	if s == nil || s.client == nil {
		return nil
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return fmt.Errorf("run_id required")
	}
	body, err := EncodeJob(runID)
	if err != nil {
		return err
	}
	taskID := TaskID(runID, maxElapsedS, ThrottleSeconds())
	headers := map[string]string{
		"Content-Type": "application/json",
		JobTokenHeader: s.authToken,
	}
	s.lastHeaders = headers
	req := &taskspb.CreateTaskRequest{
		Parent: s.queuePath,
		Task: &taskspb.Task{
			Name: s.queuePath + "/tasks/" + taskID,
			MessageType: &taskspb.Task_HttpRequest{
				HttpRequest: &taskspb.HttpRequest{
					HttpMethod: taskspb.HttpMethod_POST,
					Url:        s.targetURL,
					Headers:    headers,
					Body:       body,
				},
			},
		},
	}
	_, err = s.client.CreateTask(ctx, req)
	return ignoreAlreadyExists(err)
}

func ignoreAlreadyExists(err error) error {
	if err == nil {
		return nil
	}
	if status.Code(err) == codes.AlreadyExists {
		return nil
	}
	return err
}
