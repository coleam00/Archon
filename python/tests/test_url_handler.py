"""Unit tests for URLHandler class."""
from src.server.services.crawling.helpers.url_handler import URLHandler


class TestURLHandler:
    """Test suite for URLHandler class."""

    def test_is_binary_file_archives(self):
        """Test detection of archive file formats."""
        handler = URLHandler()

        # Should detect various archive formats
        assert handler.is_binary_file("https://example.com/file.zip") is True
        assert handler.is_binary_file("https://example.com/archive.tar.gz") is True
        assert handler.is_binary_file("https://example.com/compressed.rar") is True
        assert handler.is_binary_file("https://example.com/package.7z") is True
        assert handler.is_binary_file("https://example.com/backup.tgz") is True

    def test_is_binary_file_executables(self):
        """Test detection of executable and installer files."""
        handler = URLHandler()

        assert handler.is_binary_file("https://example.com/setup.exe") is True
        assert handler.is_binary_file("https://example.com/installer.dmg") is True
        assert handler.is_binary_file("https://example.com/package.deb") is True
        assert handler.is_binary_file("https://example.com/app.msi") is True
        assert handler.is_binary_file("https://example.com/program.appimage") is True

    def test_is_binary_file_documents(self):
        """Test detection of document files."""
        handler = URLHandler()

        assert handler.is_binary_file("https://example.com/document.pdf") is True
        assert handler.is_binary_file("https://example.com/report.docx") is True
        assert handler.is_binary_file("https://example.com/spreadsheet.xlsx") is True
        assert handler.is_binary_file("https://example.com/presentation.pptx") is True

    def test_is_binary_file_media(self):
        """Test detection of image and media files."""
        handler = URLHandler()

        # Images
        assert handler.is_binary_file("https://example.com/photo.jpg") is True
        assert handler.is_binary_file("https://example.com/image.png") is True
        assert handler.is_binary_file("https://example.com/icon.svg") is True
        assert handler.is_binary_file("https://example.com/favicon.ico") is True

        # Audio/Video
        assert handler.is_binary_file("https://example.com/song.mp3") is True
        assert handler.is_binary_file("https://example.com/video.mp4") is True
        assert handler.is_binary_file("https://example.com/movie.mkv") is True

    def test_is_binary_file_case_insensitive(self):
        """Test that detection is case-insensitive."""
        handler = URLHandler()

        assert handler.is_binary_file("https://example.com/FILE.ZIP") is True
        assert handler.is_binary_file("https://example.com/Document.PDF") is True
        assert handler.is_binary_file("https://example.com/Image.PNG") is True

    def test_is_binary_file_with_query_params(self):
        """Test that query parameters don't affect detection."""
        handler = URLHandler()

        assert handler.is_binary_file("https://example.com/file.zip?version=1.0") is True
        assert handler.is_binary_file("https://example.com/document.pdf?download=true") is True
        assert handler.is_binary_file("https://example.com/image.png#section") is True

    def test_is_binary_file_html_pages(self):
        """Test that HTML pages are not detected as binary."""
        handler = URLHandler()

        # Regular HTML pages should not be detected as binary
        assert handler.is_binary_file("https://example.com/") is False
        assert handler.is_binary_file("https://example.com/index.html") is False
        assert handler.is_binary_file("https://example.com/page") is False
        assert handler.is_binary_file("https://example.com/blog/post") is False
        assert handler.is_binary_file("https://example.com/about.htm") is False
        assert handler.is_binary_file("https://example.com/contact.php") is False

    def test_is_binary_file_edge_cases(self):
        """Test edge cases and special scenarios."""
        handler = URLHandler()

        # URLs with periods in path but not file extensions
        assert handler.is_binary_file("https://example.com/v1.0/api") is False
        assert handler.is_binary_file("https://example.com/jquery.min.js") is False  # JS files might be crawlable

        # Real-world example from the error
        assert handler.is_binary_file("https://docs.crawl4ai.com/apps/crawl4ai-assistant/crawl4ai-assistant-v1.3.0.zip") is True

    def test_is_sitemap(self):
        """Test sitemap detection."""
        handler = URLHandler()

        assert handler.is_sitemap("https://example.com/sitemap.xml") is True
        assert handler.is_sitemap("https://example.com/path/sitemap.xml") is True
        assert handler.is_sitemap("https://example.com/sitemap/index.xml") is True
        assert handler.is_sitemap("https://example.com/regular-page") is False

    def test_is_txt(self):
        """Test text file detection."""
        handler = URLHandler()

        assert handler.is_txt("https://example.com/robots.txt") is True
        assert handler.is_txt("https://example.com/readme.txt") is True
        assert handler.is_txt("https://example.com/file.pdf") is False

    def test_transform_github_url(self):
        """Test GitHub URL transformation."""
        handler = URLHandler()

        # Should transform GitHub blob URLs to raw URLs
        original = "https://github.com/owner/repo/blob/main/file.py"
        expected = "https://raw.githubusercontent.com/owner/repo/main/file.py"
        assert handler.transform_github_url(original) == expected

        # Should not transform non-blob URLs
        non_blob = "https://github.com/owner/repo"
        assert handler.transform_github_url(non_blob) == non_blob

        # Should not transform non-GitHub URLs
        other = "https://example.com/file"
        assert handler.transform_github_url(other) == other

    def test_is_robots_txt(self):
        """Test robots.txt detection."""
        handler = URLHandler()

        # Standard robots.txt URLs
        assert handler.is_robots_txt("https://example.com/robots.txt") is True
        assert handler.is_robots_txt("http://example.com/robots.txt") is True
        assert handler.is_robots_txt("https://sub.example.com/robots.txt") is True

        # Case sensitivity
        assert handler.is_robots_txt("https://example.com/ROBOTS.TXT") is True
        assert handler.is_robots_txt("https://example.com/Robots.Txt") is True

        # With query parameters (should still be detected)
        assert handler.is_robots_txt("https://example.com/robots.txt?v=1") is True
        assert handler.is_robots_txt("https://example.com/robots.txt#section") is True

        # Not robots.txt files
        assert handler.is_robots_txt("https://example.com/robots") is False
        assert handler.is_robots_txt("https://example.com/robots.html") is False
        assert handler.is_robots_txt("https://example.com/some-robots.txt") is False
        assert handler.is_robots_txt("https://example.com/path/robots.txt") is False
        assert handler.is_robots_txt("https://example.com/") is False

        # Edge case: malformed URL should not crash
        assert handler.is_robots_txt("not-a-url") is False

    def test_is_llms_variant(self):
        """Test llms file variant detection."""
        handler = URLHandler()

        # Standard llms.txt spec variants (only txt files)
        assert handler.is_llms_variant("https://example.com/llms.txt") is True
        assert handler.is_llms_variant("https://example.com/llms-full.txt") is True

        # Case sensitivity
        assert handler.is_llms_variant("https://example.com/LLMS.TXT") is True
        assert handler.is_llms_variant("https://example.com/LLMS-FULL.TXT") is True

        # With paths (should still detect)
        assert handler.is_llms_variant("https://example.com/docs/llms.txt") is True
        assert handler.is_llms_variant("https://example.com/public/llms-full.txt") is True

        # With query parameters
        assert handler.is_llms_variant("https://example.com/llms.txt?version=1") is True
        assert handler.is_llms_variant("https://example.com/llms-full.txt#section") is True

        # Not llms files
        assert handler.is_llms_variant("https://example.com/llms") is False
        assert handler.is_llms_variant("https://example.com/llms.html") is False
        assert handler.is_llms_variant("https://example.com/my-llms.txt") is False
        assert handler.is_llms_variant("https://example.com/llms-guide.txt") is False
        assert handler.is_llms_variant("https://example.com/readme.txt") is False

        # Edge case: malformed URL should not crash
        assert handler.is_llms_variant("not-a-url") is False

    def test_is_well_known_file(self):
        """Test .well-known file detection."""
        handler = URLHandler()

        # Standard .well-known files
        assert handler.is_well_known_file("https://example.com/.well-known/ai.txt") is True
        assert handler.is_well_known_file("https://example.com/.well-known/security.txt") is True
        assert handler.is_well_known_file("https://example.com/.well-known/change-password") is True

        # Case sensitivity - RFC 8615 requires lowercase .well-known
        assert handler.is_well_known_file("https://example.com/.WELL-KNOWN/ai.txt") is False
        assert handler.is_well_known_file("https://example.com/.Well-Known/ai.txt") is False

        # With query parameters
        assert handler.is_well_known_file("https://example.com/.well-known/ai.txt?v=1") is True
        assert handler.is_well_known_file("https://example.com/.well-known/ai.txt#top") is True

        # Not .well-known files
        assert handler.is_well_known_file("https://example.com/well-known/ai.txt") is False
        assert handler.is_well_known_file("https://example.com/.wellknown/ai.txt") is False
        assert handler.is_well_known_file("https://example.com/docs/.well-known/ai.txt") is False
        assert handler.is_well_known_file("https://example.com/ai.txt") is False
        assert handler.is_well_known_file("https://example.com/") is False

        # Edge case: malformed URL should not crash
        assert handler.is_well_known_file("not-a-url") is False

    def test_get_base_url(self):
        """Test base URL extraction."""
        handler = URLHandler()

        # Standard URLs
        assert handler.get_base_url("https://example.com") == "https://example.com"
        assert handler.get_base_url("https://example.com/") == "https://example.com"
        assert handler.get_base_url("https://example.com/path/to/page") == "https://example.com"
        assert handler.get_base_url("https://example.com/path/to/page?query=1") == "https://example.com"
        assert handler.get_base_url("https://example.com/path/to/page#fragment") == "https://example.com"

        # HTTP vs HTTPS
        assert handler.get_base_url("http://example.com/path") == "http://example.com"
        assert handler.get_base_url("https://example.com/path") == "https://example.com"

        # Subdomains and ports
        assert handler.get_base_url("https://api.example.com/v1/users") == "https://api.example.com"
        assert handler.get_base_url("https://example.com:8080/api") == "https://example.com:8080"
        assert handler.get_base_url("http://localhost:3000/dev") == "http://localhost:3000"

        # Complex cases
        assert handler.get_base_url("https://user:pass@example.com/path") == "https://user:pass@example.com"

        # Edge cases - malformed URLs should return original
        assert handler.get_base_url("not-a-url") == "not-a-url"
        assert handler.get_base_url("") == ""
        assert handler.get_base_url("ftp://example.com/file") == "ftp://example.com"

        # Missing scheme or netloc
        assert handler.get_base_url("//example.com/path") == "//example.com/path"  # Should return original
        assert handler.get_base_url("/path/to/resource") == "/path/to/resource"  # Should return original
