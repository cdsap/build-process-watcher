package predictionqueue

import (
	"context"
	"testing"

	taskspb "cloud.google.com/go/cloudtasks/apiv2/cloudtaskspb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeTaskClient struct {
	request *taskspb.CreateTaskRequest
	err     error
}

func (f *fakeTaskClient) CreateTask(_ context.Context, request *taskspb.CreateTaskRequest) (*taskspb.Task, error) {
	f.request = request
	return nil, f.err
}

func (f *fakeTaskClient) Close() error { return nil }

func TestCloudTasksScheduleCreatesNamedHTTPTask(t *testing.T) {
	client := &fakeTaskClient{}
	scheduler := &CloudTasks{
		client:       client,
		queuePath:    "projects/project/locations/location/queues/predictions",
		targetURL:    "https://example.test/internal/prediction-jobs",
		authToken:    "job-secret",
		throttleMode: "forecast",
	}

	if err := scheduler.Schedule(context.Background(), "run-1", 41); err != nil {
		t.Fatal(err)
	}
	if client.request == nil {
		t.Fatal("CreateTask was not called")
	}
	if got := client.request.Task.GetName(); got != scheduler.queuePath+"/tasks/eval-run-1-b2" {
		t.Fatalf("task name = %q", got)
	}
	httpRequest := client.request.Task.GetHttpRequest()
	if httpRequest.GetUrl() != scheduler.targetURL || httpRequest.GetHttpMethod() != taskspb.HttpMethod_POST {
		t.Fatalf("HTTP request = %#v", httpRequest)
	}
	if got := httpRequest.GetHeaders()[JobTokenHeader]; got != "job-secret" {
		t.Fatalf("%s = %q, want job-secret", JobTokenHeader, got)
	}
	job, err := DecodeJob(httpRequest.GetBody())
	if err != nil || job.RunID != "run-1" {
		t.Fatalf("job = %#v, err = %v", job, err)
	}
}

func TestCloudTasksScheduleTreatsAlreadyExistsAsSuccess(t *testing.T) {
	client := &fakeTaskClient{err: status.Error(codes.AlreadyExists, "duplicate task")}
	scheduler := &CloudTasks{
		client:       client,
		queuePath:    "projects/project/locations/location/queues/predictions",
		targetURL:    "https://example.test/internal/prediction-jobs",
		authToken:    "job-secret",
		throttleMode: "predict",
	}

	if err := scheduler.Schedule(context.Background(), "run-1", 41); err != nil {
		t.Fatalf("Schedule returned dedupe error: %v", err)
	}
}
