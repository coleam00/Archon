export type TextRedactor = (text: string) => string;
export type DiagnosticText = (redact: TextRedactor) => string;

// A fixture can retain the original diagnostic for simulation, then render it with
// credential protection before lossy previews only if the fixture fails.
export type DiagnosticTextFormatter = (render: DiagnosticText) => string;
export const unredactedDiagnosticText: DiagnosticTextFormatter = render => render(text => text);
