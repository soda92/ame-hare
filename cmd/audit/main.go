// Command audit checks an extracted NScripter script for missing labels,
// unbalanced for/next loops, unhandled commands, and missing assets.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"

	"amehare/pkg/audit"
)

func main() {
	script := flag.String("script", "./data/script.txt", "UTF-8 script to audit")
	data := flag.String("data", "./data", "extracted asset directory")
	vm := flag.String("vm", "./web-app/src/game/vm.ts", "VM source used to derive the implemented command list")
	jsonOut := flag.Bool("json", false, "emit JSON")
	verbose := flag.Bool("verbose", false, "print command counts and no-op commands")
	noAssets := flag.Bool("no-assets", false, "skip asset existence checks")
	flag.Parse()

	buf, err := os.ReadFile(*script)
	if err != nil {
		log.Fatalf("audit: %v", err)
	}
	rep := audit.Run(string(buf), audit.Options{
		ScriptPath: *script,
		DataDir:    *data,
		VMSource:   *vm,
		Verbose:    *verbose,
		NoAssets:   *noAssets,
		NoopCheck:  *verbose,
	})

	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(rep); err != nil {
			log.Fatal(err)
		}
	} else {
		printText(rep, *verbose)
	}
	if rep.Errors > 0 {
		os.Exit(1)
	}
}

func printText(rep audit.Report, verbose bool) {
	fmt.Printf("amehare audit: %s\n", rep.Script)
	fmt.Printf("  lines: %d  labels: %d  commands: %d\n", rep.Lines, rep.Labels, len(rep.Commands))
	fmt.Printf("  errors: %d  warnings: %d\n", rep.Errors, rep.Warnings)
	if len(rep.MissingAssets) == 0 {
		fmt.Println("  missing assets: none")
	} else {
		fmt.Printf("  missing assets: %d\n", len(rep.MissingAssets))
		for _, a := range rep.MissingAssets {
			fmt.Printf("    %s\n", a)
		}
	}
	if len(rep.NoopCommands) > 0 {
		fmt.Printf("  accepted no-op commands: %s\n", join(rep.NoopCommands))
	}
	if len(rep.Issues) > 0 {
		fmt.Println()
		for _, is := range rep.Issues {
			fmt.Printf("  %-5s %-8s line %6d  %s\n", is.Level, is.Kind, is.Line, is.Message)
		}
	}
	if verbose {
		fmt.Println()
		fmt.Println("commands:")
		names := make([]string, 0, len(rep.Commands))
		for name := range rep.Commands {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			fmt.Printf("  %6d  %s\n", rep.Commands[name], name)
		}
	}
}

func join(xs []string) string {
	out := ""
	for i, x := range xs {
		if i > 0 {
			out += ", "
		}
		out += x
	}
	return out
}
