# Patterns

Pattern engine, rule matchers, regular expressions, and snapshot matching for fast-path decisions.

Status: **implemented and tested**.

The safety check is advisory; it never prevents an agent from acting.

## Matchers

- `text_any`: Case-insensitive substring match across element texts or page text.
- `text_regex`: Regular expression matched against element text, bounded to guard against catastrophic backtracking.
- `role`: Element accessibility role matching.
- `url_domain`: Hostname and subdomain matching.
- `url_path`: Pathname matching with prefix, wildcard and regex support.
- `file_path_glob`: Fast glob matching across file paths.
- `exit_code`: Numeric exit code matching.
- `log_regex`: Regular expression matched against log excerpts, bounded to guard against catastrophic backtracking.

## Precedence

1. **Safety rules always take precedence** over non-safety rules.
2. **Most specific rule wins** based on matcher specificity scoring.
3. **Deterministic tie-break by ID**.
