package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/relprogress"
)

func main() {
	inputPath := flag.String("input", "", "path to private relative-progress fixture JSON")
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
	fmt.Print(markdown)
}
