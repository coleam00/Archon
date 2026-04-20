# Homebrew formula for HarnessLab CLI
# To install from a configured tap: brew install <tap>/archon
#
# This formula downloads pre-built binaries from GitHub releases and is updated
# automatically by .github/workflows/release.yml after stable releases.
# For development, see: https://github.com/NewTurn2017/Archon

class Archon < Formula
  desc "Remote agentic coding platform - control AI assistants from anywhere"
  homepage "https://github.com/NewTurn2017/Archon"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/NewTurn2017/Archon/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/NewTurn2017/Archon/releases/download/v#{version}/archon-darwin-x64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/NewTurn2017/Archon/releases/download/v#{version}/archon-linux-arm64"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/NewTurn2017/Archon/releases/download/v#{version}/archon-linux-x64"
      sha256 "PLACEHOLDER_SHA256_LINUX_X64"
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

  test do
    # Basic version check - archon version should exit with 0 on success
    assert_match version.to_s, shell_output("#{bin}/archon version")
  end
end
