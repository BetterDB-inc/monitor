SHELL := /usr/bin/env bash
export PATH := $(CURDIR)/.bin:$(HOME)/.nvm/versions/node/v22.12.0/bin:$(PATH)
SIM := pnpm exec tsx src/cli.ts

.PHONY: preflight up verify-kind verify-cluster betterdb verify-betterdb warm load scenario report reset down all

preflight:
	./scripts/preflight.sh

node_modules: package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile
	@touch node_modules

up: preflight node_modules
	$(SIM) kind-up
	$(SIM) verify-kind
	$(SIM) chaos-up
	$(SIM) operator-up
	$(SIM) cluster-up
	$(SIM) verify-cluster

verify-kind: node_modules
	$(SIM) verify-kind

verify-cluster: node_modules
	$(SIM) verify-cluster

betterdb: node_modules
	$(SIM) betterdb
	$(SIM) verify-betterdb

verify-betterdb: node_modules
	$(SIM) verify-betterdb

warm: node_modules
	$(SIM) warm

load: node_modules
	$(SIM) load

# PHASES=spike,primaryKill for a subset; DRY_RUN=1 prints the timeline.
scenario: node_modules
	$(SIM) scenario

# RUN=<run-id>; defaults to the latest run.
report: node_modules
	$(SIM) report

# Restore image/config/data to the sim.yaml baseline without recreating kind (between takes).
reset: node_modules
	$(SIM) reset

# KEEP_CLUSTER=1 removes only workloads; default deletes the kind cluster this repo created.
down:
	./scripts/down.sh

all: up betterdb warm scenario report

# Shareable PDF + screenshots: RUNS=<full-run-id>[,<rerun-id>]
prospect: node_modules
	$(SIM) prospect
