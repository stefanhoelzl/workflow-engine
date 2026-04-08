# Dashboard Timeline Specification

## Purpose

Provide the SVG timeline visualization for a single correlation chain, including tree layout, node and edge rendering, scroll constraints, and tooltip interactions.

## Requirements

### Requirement: Timeline fragment route
The system SHALL serve an SVG timeline fragment at `GET /dashboard/timeline/:correlationId` showing all events for the given correlationId.

#### Scenario: Timeline request
- **WHEN** `GET /dashboard/timeline/corr_abc123` is requested
- **THEN** the response is an HTML fragment containing an SVG element representing the event tree

#### Scenario: Unknown correlationId
- **WHEN** `GET /dashboard/timeline/corr_nonexistent` is requested
- **THEN** the response contains an empty state or "no events found" message

### Requirement: Event tree layout
The system SHALL build an event tree from `parentEventId` links and render it as a horizontal SVG graph.

#### Scenario: Linear chain
- **WHEN** events form a linear chain (each event has one child)
- **THEN** nodes are laid out left-to-right on a single horizontal line

#### Scenario: Branching
- **WHEN** an event has multiple children (fan-out)
- **THEN** child nodes branch vertically from the parent, evenly spaced above and below the parent's Y position

#### Scenario: X-axis spacing
- **WHEN** the timeline is rendered
- **THEN** nodes are evenly spaced along the X-axis (topology view, not time-proportional)

### Requirement: Node rendering
The system SHALL render each event as a node with state-colored circle, event type label, and action name.

#### Scenario: Done event
- **WHEN** an event has current state `done`
- **THEN** the node circle is green and filled

#### Scenario: Pending or processing event
- **WHEN** an event has current state `pending` or `processing`
- **THEN** the node circle is yellow and filled

#### Scenario: Failed event
- **WHEN** an event has current state `failed`
- **THEN** the node circle is red and filled

#### Scenario: Skipped event
- **WHEN** an event has current state `skipped`
- **THEN** the node circle is grey and hollow (stroke only, no fill)

#### Scenario: Node labels
- **WHEN** a node is rendered
- **THEN** the event type is shown below the circle in monospace font
- **THEN** the action name (`targetAction`) is shown below the event type in a smaller font

### Requirement: Edge rendering
The system SHALL render edges between parent and child events as curved SVG paths.

#### Scenario: Parent-child connection
- **WHEN** an event has a `parentEventId`
- **THEN** a cubic bezier SVG path connects the parent node to the child node

### Requirement: Timeline container constraints
The timeline container SHALL respect viewport constraints with scroll support.

#### Scenario: Vertical overflow
- **WHEN** the SVG height exceeds 50% of the viewport height
- **THEN** the container shows a vertical scrollbar

#### Scenario: Horizontal overflow
- **WHEN** the SVG width exceeds the container width
- **THEN** the container shows a horizontal scrollbar

### Requirement: Tooltip on hover
The system SHALL show a tooltip popover when hovering over a timeline node, using Alpine.js for positioning.

#### Scenario: Tooltip display
- **WHEN** the user hovers over a node circle in the SVG
- **THEN** a tooltip appears near the node showing: event type, state, action, timestamp, and formatted JSON payload

#### Scenario: Failed event tooltip
- **WHEN** the user hovers over a failed event node
- **THEN** the tooltip additionally shows the error details in a red-styled block

#### Scenario: Tooltip dismissal
- **WHEN** the user moves the mouse away from the node
- **THEN** the tooltip disappears

#### Scenario: Tooltip not clipped
- **WHEN** a tooltip is shown for a node near the edge of the timeline container
- **THEN** the tooltip is rendered at `<body>` level and is not clipped by the scroll container
