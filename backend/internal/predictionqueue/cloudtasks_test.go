package predictionqueue

import (
	"context"
	"testing"

	taskspb "cloud.google.com/go/cloudtasks/apiv2/cloudtaskspb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeTaskCreator struct {
	err   error
	calls int
	req   *taskspb.CreateTaskRequest
}

func (f *fakeTaskCreator) CreateTask(_ context.Context, req *taskspb.CreateTaskRequest) (*taskspb.Task, error) {
	f.calls++
	f.req = req
	return &taskspb.Task{}, f.err
}

func (f *fakeTaskCreator) Close() error { return nil }

func TestIgnoreAlreadyExists(t *testing.T) {
	if err := ignoreAlreadyExists(nil); err != nil {
		t.Fatalf("nil => %v", err)
	}
	if err := ignoreAlreadyExists(status.Error(codes.AlreadyExists, "dup")); err != nil {
		t.Fatalf("AlreadyExists should be success, got %v", err)
	}
	if err := ignoreAlreadyExists(status.Error(codes.Unavailable, "down")); err == nil {
		t.Fatal("other errors should propagate")
	}
}

func TestScheduleTreatsAlreadyExistsAsSuccess(t *testing.T) {
	fake := &fakeTaskCreator{err: status.Error(codes.AlreadyExists, "already exists")}
	s := &CloudTasks{
		client:    fake,
		queuePath: "projects/p/locations/l/queues/q",
		targetURL: "https://example.test/internal/prediction-jobs",
		authToken: "secret",
	}
	if err := s.Schedule(context.Background(), "run-1", 40, 10); err != nil {
		t.Fatalf("AlreadyExists schedule: %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("calls=%d", fake.calls)
	}
	if got := s.lastHeaders[JobTokenHeader]; got != "secret" {
		t.Fatalf("token header=%q", got)
	}
	httpReq := fake.req.GetTask().GetHttpRequest()
	if httpReq.GetHeaders()[JobTokenHeader] != "secret" {
		t.Fatalf("request headers=%v", httpReq.GetHeaders())
	}
}

func TestSchedulePropagatesOtherErrors(t *testing.T) {
	fake := &fakeTaskCreator{err: status.Error(codes.Unavailable, "down")}
	s := &CloudTasks{
		client:    fake,
		queuePath: "projects/p/locations/l/queues/q",
		targetURL: "https://example.test/internal/prediction-jobs",
		authToken: "secret",
	}
	if err := s.Schedule(context.Background(), "run-1", 20, 10); err == nil {
		t.Fatal("expected error")
	}
}

func TestScheduleTaskIDRespectsThrottle(t *testing.T) {
	fake := &fakeTaskCreator{}
	s := &CloudTasks{
		client:    fake,
		queuePath: "projects/p/locations/l/queues/q",
		targetURL: "https://example.test/internal/prediction-jobs",
		authToken: "secret",
	}
	if err := s.Schedule(context.Background(), "run-1", 25, 10); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	name := fake.req.GetTask().GetName()
	if want := "projects/p/locations/l/queues/q/tasks/eval-run-1-b2"; name != want {
		t.Fatalf("task name = %q, want %q", name, want)
	}
	fake.calls = 0
	if err := s.Schedule(context.Background(), "run-1", 25, 20); err != nil {
		t.Fatalf("schedule with 20s throttle: %v", err)
	}
	name = fake.req.GetTask().GetName()
	if want := "projects/p/locations/l/queues/q/tasks/eval-run-1-b1"; name != want {
		t.Fatalf("20s throttle task name = %q, want %q", name, want)
	}
}
