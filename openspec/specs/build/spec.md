# Build Pipeline Specification

## Purpose

Transform a TypeScript workflow project into a deployable artifact consisting of bundled action files and a manifest describing the workflow graph.

## Requirements

### Requirement: Vite plugin with Rolldown bundling

The system SHALL provide a Vite plugin that configures action files as Vite entry points and lets Rolldown handle all bundling.

#### Scenario: Build produces action bundles

- GIVEN a workflow with actions `parseOrder` and `sendEmail`
- WHEN `vite build` runs with the workflow plugin
- THEN `dist/actions/parseOrder.js` and `dist/actions/sendEmail.js` are produced
- AND each file is self-contained with no external imports

### Requirement: DSL execution at build time

The Vite plugin SHALL import and execute `workflow.ts` at build time to discover action entry points and wiring. This is safe because the DSL is SDK code that produces a plain config object with no side effects.

#### Scenario: Plugin reads workflow config

- GIVEN `workflow.ts` uses the DSL to define triggers, events, and actions
- WHEN the plugin's `config` hook runs
- THEN it imports `workflow.ts` and calls `getActionEntries()` to get a map of action names to file paths
- AND configures them as Rolldown input entries

### Requirement: Manifest generation

The Vite plugin SHALL emit a `manifest.json` file in the `generateBundle` hook describing the workflow graph.

#### Scenario: Manifest content

- GIVEN a workflow with one HTTP trigger, two events, and two actions
- WHEN the build completes
- THEN `dist/manifest.json` contains: workflow name, trigger configurations, subscriptions (event → action → file mappings), and action emit declarations

### Requirement: Manifest-only wiring

The manifest SHALL contain only wiring information: trigger configs, event-to-action subscriptions, and action emit declarations. No Zod schemas, no action metadata, no code.

### Requirement: No build-time graph validation

The Vite plugin SHALL NOT validate the workflow graph (orphan events, cycles, type mismatches) in v1. TypeScript's type checker provides compile-time safety.

### Requirement: Build output structure

The build SHALL produce the following structure:

```
dist/
├── manifest.json
└── actions/
    ├── <actionName>.js
    └── ...
```
