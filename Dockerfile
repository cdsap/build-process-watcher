# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /src
ENV GONOSUMDB=github.com/cdsap/build-process-watcher/backend

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /tmp/predictive-backend ./cmd/predictive-backend

# Runtime stage
FROM alpine:3.22

RUN apk --no-cache add ca-certificates

WORKDIR /app
COPY --from=builder /tmp/predictive-backend ./predictive-backend

EXPOSE 8080
CMD ["./predictive-backend"]
