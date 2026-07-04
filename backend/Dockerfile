# Build stage
FROM gcr.io/bazel-public/bazel:8.5.0 AS builder

WORKDIR /workspace

COPY . .
RUN bazel build //:server && cp -L bazel-bin/server /tmp/main

# Runtime stage
FROM alpine:latest

# Install ca-certificates for HTTPS requests
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy the binary from builder
COPY --from=builder /tmp/main .

# Expose port 8080 (Cloud Run default)
EXPOSE 8080

# Run the application
CMD ["./main"]
