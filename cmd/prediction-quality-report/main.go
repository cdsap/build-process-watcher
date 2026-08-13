package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/quality"
)

func main() {
	inputPath := flag.String("input", "", "path to private prediction-attempt fixture or exported sample JSON")
	outDir := flag.String("out", "", "optional directory for private report artifacts (prediction-quality-report.json and prediction-quality-report.md)")
	format := flag.String("format", "markdown", "stdout format: markdown or json")
	flag.Parse()

	if *inputPath == "" {
		fmt.Fprintln(os.Stderr, "-input is required")
		os.Exit(2)
	}

	dataset, err := quality.LoadPredictionDatasetFile(*inputPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read input: %v\n", err)
		os.Exit(1)
	}
	report, err := quality.EvaluatePredictions(dataset)
	if err != nil {
		fmt.Fprintf(os.Stderr, "evaluate: %v\n", err)
		os.Exit(1)
	}

	markdown, err := quality.RenderPredictionMarkdown(report)
	if err != nil {
		fmt.Fprintf(os.Stderr, "render: %v\n", err)
		os.Exit(1)
	}

	if *outDir != "" {
		if err := os.MkdirAll(*outDir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "create out dir: %v\n", err)
			os.Exit(1)
		}
		jsonPath := filepath.Join(*outDir, "prediction-quality-report.json")
		mdPath := filepath.Join(*outDir, "prediction-quality-report.md")
		if err := quality.SavePredictionReportJSON(jsonPath, report); err != nil {
			fmt.Fprintf(os.Stderr, "write json: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(mdPath, []byte(markdown), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write markdown: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "wrote %s\n", jsonPath)
		fmt.Fprintf(os.Stderr, "wrote %s\n", mdPath)
	}

	switch *format {
	case "markdown":
		fmt.Print(markdown)
	case "json":
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(report); err != nil {
			fmt.Fprintf(os.Stderr, "write json: %v\n", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintf(os.Stderr, "unsupported -format %q (use markdown or json)\n", *format)
		os.Exit(2)
	}
}
