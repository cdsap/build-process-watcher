package ingest

import (
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// ParseData parses the monitoring data string into samples.
// Accepts 6-, 7-, and 14-field pipe-delimited records.
func ParseData(data string, startTime time.Time) ([]models.Sample, error) {
	var samples []models.Sample
	lines := strings.Split(strings.TrimSpace(data), "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) != 6 && len(parts) != 7 && len(parts) != 14 {
			continue
		}

		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}

		timeParts := strings.Split(parts[0], ":")
		if len(timeParts) != 3 {
			continue
		}
		hours, err1 := strconv.Atoi(timeParts[0])
		minutes, err2 := strconv.Atoi(timeParts[1])
		seconds, err3 := strconv.Atoi(timeParts[2])
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		elapsedTime := hours*3600 + minutes*60 + seconds

		heapUsed, ok := parseMBField(parts[3])
		if !ok {
			continue
		}
		heapCap, ok := parseMBField(parts[4])
		if !ok {
			continue
		}
		rss, ok := parseMBField(parts[5])
		if !ok {
			continue
		}

		var gcTime int
		if len(parts) >= 7 {
			gcTime = parseGCTime(parts[6])
		}

		timestamp := startTime.Add(time.Duration(elapsedTime) * time.Second)

		sample := models.Sample{
			Timestamp:                  toMillis(timestamp),
			ElapsedTime:                elapsedTime,
			PID:                        parts[1],
			Name:                       parts[2],
			HeapUsed:                   heapUsed,
			HeapCap:                    heapCap,
			RSS:                        rss,
			GCTime:                     gcTime,
			JITCompiledMethods:         parseOptionalInt(parts, 7, false),
			JITFailedCompilations:      parseOptionalInt(parts, 8, false),
			JITInvalidatedCompilations: parseOptionalInt(parts, 9, false),
			JITCompilationTimeMs:       parseOptionalInt(parts, 10, true),
			ClassesLoaded:              parseOptionalInt(parts, 11, false),
			ClassesUnloaded:            parseOptionalInt(parts, 12, false),
			ClassLoadTimeMs:            parseOptionalInt(parts, 13, true),
		}

		samples = append(samples, sample)
	}

	return samples, nil
}

func parseMBField(raw string) (int, bool) {
	trimmed := strings.TrimSuffix(strings.TrimSuffix(raw, "MB"), "MB")
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return int(value), true
}

func parseGCTime(raw string) int {
	isMilliseconds := strings.HasSuffix(raw, "ms")
	isSeconds := !isMilliseconds && strings.HasSuffix(raw, "s")

	gcTimeStr := raw
	if isMilliseconds {
		gcTimeStr = strings.TrimSuffix(gcTimeStr, "ms")
	} else if isSeconds {
		gcTimeStr = strings.TrimSuffix(gcTimeStr, "s")
	}

	if gcTimeStr == "N/A" || gcTimeStr == "" {
		return 0
	}
	gcTimeFloat, err := strconv.ParseFloat(gcTimeStr, 64)
	if err != nil {
		return 0
	}
	if isSeconds {
		return int(gcTimeFloat * 1000)
	}
	return int(gcTimeFloat)
}

func parseOptionalInt(parts []string, index int, secondsToMillis bool) *int {
	if index >= len(parts) || parts[index] == "" || parts[index] == "N/A" {
		return nil
	}
	value, err := strconv.ParseFloat(strings.TrimSuffix(parts[index], "s"), 64)
	if err != nil {
		return nil
	}
	if secondsToMillis {
		value *= 1000
	}
	parsed := int(value)
	return &parsed
}

func toMillis(t time.Time) int64 {
	return t.UnixNano() / int64(time.Millisecond)
}
