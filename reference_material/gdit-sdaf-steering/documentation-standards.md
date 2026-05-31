# Documentation Standards

Reference examples: `~/.kiro/steering/documentation-standards-reference.md`

**Protocol**: DOC-STANDARDS
**Version**: 1.0
**Created**: 2026-03-10
**Purpose**: Standards for creating and maintaining project documentation

---

## Markdown to PDF Conversion

### Standard Tool

Use `.kiro/scripts/md2pdf.py` for all markdown to PDF conversions.

### Features

- Proper bullet indentation (40px first level, 30px nested)
- Code block formatting with syntax preservation
- Table formatting with alternating row colors
- Header hierarchy with visual styling
- Professional styling for compliance documents

### Requirements

- Python 3
- google-chrome (for headless PDF generation)

### Formatting Standards

**Bullet Lists**: Use `-` for bullets, 2-space indentation for nesting
**Code Blocks**: Triple backticks, inline code uses single backticks
**Headers**: H1 blue underline 20pt, H2 gray underline 16pt, H3 13pt, H4 11pt
**Tables**: Blue header row, alternating row colors, 1px borders

### When to Generate PDFs

Generate for: compliance docs, formal specs, release docs, audit artifacts, external distribution
Do NOT generate for: working documents, internal notes, temporary specs, drafts

### File Naming

PDF files use same name as markdown source, stored in same directory.

### Version Control

Commit both .md and .pdf together. Regenerate PDF when markdown updates.

---

## Markdown Style Guide

- **Headers**: ATX-style with space after `#`
- **Lists**: `-` for unordered, 2-space nesting; `1.` for ordered
- **Code**: Backticks for inline, triple backticks for blocks
- **Emphasis**: `**bold**`, `*italic*`, `***bold italic***`
- **Links**: `[text](url)` for external, `[text](./path)` for internal
- **Tables**: Pipe-delimited with header separator row
- **Horizontal Rules**: Three dashes `---`

---

## Protocol Headers

All specification documents must include: Protocol name, Version, Created date, Related files.

---

## Evidence Documentation Standards

### Command Documentation

Include full commands with all switches, configuration file references with line numbers, source file references.

### Configuration References

Reference with full file path, specific line numbers/ranges, section names.

### Policy References

Reference with document name/path, section numbers/names, line numbers.

### Validation Commands

Include complete commands with expected outputs.

---

## Appendix Standards

For compliance documents, include:

- **Appendix A**: Configuration files with path, usage, annotations
- **Appendix B**: Command reference with parameters, config refs, example outputs
- **Appendix C**: Validation procedures with prerequisites, commands, expected outputs, troubleshooting
