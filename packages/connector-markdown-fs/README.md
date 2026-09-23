# Markdown filesystem connector

This package is the first real state connector in the lab. It maps YAML frontmatter in Markdown files into the canonical reconciliation model without making Obsidian a core dependency.

## External IDs

External IDs are portable, root-relative Markdown paths using forward slashes, for example:

`Projects/Atlas.md`

Absolute paths, backslashes, empty/dot/parent segments, non-Markdown files, and symlink targets that resolve outside the configured root are rejected.

## Field paths

A plain external field such as `deadline` addresses one top-level frontmatter key.

A field beginning with `/` uses JSON Pointer escaping for nested map paths:

`/project/owner`

The pointer segment `~1` means `/` and `~0` means `~`.

## Revisions and writes

The provider exposes an opaque `sha256:<digest>` revision of the entire Markdown file. A write requires the observed revision. If the file changed after observation, the write fails rather than silently replacing the new content.

Writes serialize the YAML document into a temporary file in the same directory, re-check the source revision, and then rename the temporary file over the target. Markdown body content is retained unchanged. The YAML Document model is used so unrelated fields and comments are retained where supported by the library.

This is not a claim of linearizable cross-process compare-and-swap: there remains a small race between the second revision check and the filesystem rename. An eventual Obsidian plugin adapter should use Obsidian's own `Vault.process()` / frontmatter APIs for stronger in-app mutation semantics.

## Scope

The connector intentionally does not implement filesystem watching, subscriptions, vault discovery, Obsidian-specific APIs, Markdown body semantic extraction, or universal property inference.
