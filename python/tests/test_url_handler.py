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
