# Recon: {{original app}} ({{platform}})

Scope: {{the slice being rebuilt}}
For: {{the user, and what they'll use it for}}
Date: {{YYYY-MM-DD}}

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | help centre | | |

## Core loop

{{one sentence: what people use the app for}}

## Screens

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | | | | | empty, filled, error |

## Flows

```
F01 {{goal}}
    S01 -> S02 -> S03
    happy path: {{n}} clicks
    edge: {{cases}}
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Button | primary, secondary, ghost, danger | default, hover, focus, disabled, loading | all |

## Data model and file formats

```
{{Entity}}  {{fields}}
            evidence: {{screen IDs, help pages}}
            confidence: high | medium | guess
```

Links: {{Document 1-n Section, ...}}
Formats: {{.docx read/write via <library> (licence, how complete)}}

## Feature matrix

See `features.csv`. Must: {{n}}, should: {{n}}, could: {{n}}, skip: {{n}}.

## Out of scope

- {{licensed content, the original's cloud and users, partner deals, ...}}

## Size

Screens {{n}}, flows {{n}}, entities {{n}}. Hard parts: {{list}}. Size: {{S | M | L | XL}}.
