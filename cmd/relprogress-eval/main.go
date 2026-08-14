package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/relprogress"
)

func main() {
	inputPath := flag.String("input", "", "path to private relative-progress fixture or finished-run corpus JSON")
	outDir := flag.String("out", "", "optional directory for private report artifacts (relprogress-eval.json and relprogress-eval.md)")
	format := flag.String("format", "markdown", "stdout format: markdown or json")
	flag.Parse()
	if *inputPath == "" {
		fmt.Fprintln(os.Stderr, "-input is required")
		os.Exit(2)
	}

	source, runs, err := relprogress.LoadFixtureFile(*inputPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read input: %v\n", err)
		os.Exit(1)
	}

	report, err := relprogress.RunFixtureStudy(context.Background(), source, runs, relprogress.DefaultEvidenceBar())
	if err != nil {
		fmt.Fprintf(os.Stderr, "study: %v\n", err)
		os.Exit(1)
	}
	markdown, err := relprogress.RenderMarkdown(report)
	if err != nil {
		fmt.Fprintf(os.Stderr, "render: %v\n", err)
		os.Exit(1)
	}

	if *outDir != "" {
		if err := os.MkdirAll(*outDir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "create out dir: %v\n", err)
			os.Exit(1)
		}
		jsonPath := filepath.Join(*outDir, "relprogress-eval.json")
		mdPath := filepath.Join(*outDir, "relprogress-eval.md")
		if err := relprogress.SaveStudyReportJSON(jsonPath, report); err != nil {
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
