# /memory-search

Search through stored memories using semantic search.

## Usage

```
/memory-search <query>
```

## Arguments

- `query`: The search query to find relevant memories

## Examples

```
/memory-search how to implement authentication
/memory-search React component patterns
/memory-search database optimization
```

## Description

This command searches through all stored conversation memories using semantic similarity. It returns the most relevant memories that match your query, along with their confidence scores.

The search uses AXIOMMIND weighted scoring:
- **High confidence** (≥0.92): Strong match, likely relevant
- **Suggested** (≥0.75): May be relevant, review recommended
- **None** (<0.75): No significant matches found

## Implementation

```bash
node dist/cli/index.js search "$ARGUMENTS"
```
