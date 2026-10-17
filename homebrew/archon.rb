# Homebrew formula for Archon CLI
# To install: brew install coleam00/archon/archon
#
# This formula downloads pre-built binaries from GitHub releases.
# For development, see: https://github.com/coleam00/Archon

class Archon < Formula
  desc "Governed agentic automation engine"
  homepage "https://github.com/coleam00/Archon"
  version "0.12.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "f8017d76d450115b5cabfc2c7970086aa7057cda7b36e60e76c272b3af8cf9e3"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-x64"
      sha256 "a4aa2e15872202abfb7e6c6ae3419f7068dd719ccd1cd114429ecb1515b5aec8"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-arm64"
      sha256 "6a3fbb7818a87683102872fbee9200222c5e10d5235e66111533713146874910"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-x64"
      sha256 "21fd00ffd6a7cd531e784acf94d842a4f56ed1810a38d018920e26dc3c00f35b"
    end
  end

  def install
    binary_name = case
    when OS.mac? && Hardware::CPU.arm?
      "archon-darwin-arm64"
    when OS.mac? && Hardware::CPU.intel?
      "archon-darwin-x64"
    when OS.linux? && Hardware::CPU.arm?
      "archon-linux-arm64"
    when OS.linux? && Hardware::CPU.intel?
      "archon-linux-x64"
    end

    bin.install binary_name => "archon"
  end

  def caveats
    <<~EOS
      Archon ships without AI providers. Add the ones you use:
        archon setup
      or directly:
        archon provider add <claude|codex|pi>

      Adding a provider connects Archon to your agent CLI or SDK; it does not install that CLI.

      After `brew upgrade archon`, run `archon provider add` again for each
      provider you use; installed providers must match the CLI version.
    EOS
  end

  test do
    # Basic version check - archon version should exit with 0 on success
    assert_match version.to_s, shell_output("#{bin}/archon version")
  end
end
