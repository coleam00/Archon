#!/usr/bin/env python3
"""
Quick test script for Docling PDF extraction.
"""

import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from server.utils.document_processing import extract_text_from_pdf_docling


def test_docling():
    """Test Docling with a sample PDF if available."""

    # Look for test PDF
    pdf_path = Path("/Volumes/DATEN/Coding/INFRASTRUCTURE_PROJECT/archon-local_supabase/Trading Option Greeks_ How Time, Volatilit - Dan Passarelli.pdf")

    if not pdf_path:
        print("❌ No test PDF found")
        print("Please place a PDF at ~/Downloads/sample.pdf")
        return False

    print(f"📄 Testing Docling with: {pdf_path}")

    try:
        with open(pdf_path, "rb") as f:
            pdf_content = f.read()

        print("🔄 Extracting text with Docling...")
        text = extract_text_from_pdf_docling(pdf_content)

        print(f"✅ Success! Extracted {len(text)} characters")
        print(f"\n📝 First 500 chars:\n{text[:500]}")

        return True

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = test_docling()
    sys.exit(0 if success else 1)
