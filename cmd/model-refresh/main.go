package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/promotion"
)

func main() {
	reportPath := flag.String("report", "", "path to private quality report JSON")
	registryPath := flag.String("registry", "", "path to current promotion registry JSON")
	gatePath := flag.String("gate", "", "optional path to gate override JSON")
	outPath := flag.String("out", "", "optional path to write the resulting registry JSON")
	dryRun := flag.Bool("dry-run", false, "evaluate refresh and promotion without writing the registry")
	flag.Parse()

	if *reportPath == "" {
		fmt.Fprintln(os.Stderr, "-report is required")
		os.Exit(2)
	}
	if !*dryRun && *outPath == "" {
		fmt.Fprintln(os.Stderr, "-out is required unless -dry-run is set")
		os.Exit(2)
	}

	report, err := promotion.LoadQualityReport(*reportPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load quality report: %v\n", err)
		os.Exit(1)
	}
	previous := promotion.Registry{Models: []promotion.PromotedModel{}}
	if *registryPath != "" {
		previous, err = promotion.LoadRegistry(*registryPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "load registry: %v\n", err)
			os.Exit(1)
		}
	}
	gate, err := promotion.LoadGate(*gatePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load gate: %v\n", err)
		os.Exit(1)
	}

	result, err := promotion.Refresh(previous, report, gate, *dryRun, time.Now().UTC())
	if err != nil {
		fmt.Fprintf(os.Stderr, "refresh: %v\n", err)
		os.Exit(1)
	}

	if !*dryRun {
		if err := promotion.SaveRegistry(*outPath, result.Registry); err != nil {
			fmt.Fprintf(os.Stderr, "write registry: %v\n", err)
			os.Exit(1)
		}
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		fmt.Fprintf(os.Stderr, "write result: %v\n", err)
		os.Exit(1)
	}
}
