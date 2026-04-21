# Homebrew formula for HarneesLab CLI
# To install from a configured tap: brew install <tap>/hlab
#
# This formula downloads pre-built binaries from GitHub releases and is updated
# automatically by .github/workflows/release.yml after stable releases.
# For development, see: https://github.com/NewTurn2017/HarneesLab

class Hlab < Formula
  desc "HarneesLab CLI for repeatable AI coding workflows"
  homepage "https://github.com/NewTurn2017/HarneesLab"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/NewTurn2017/HarneesLab/releases/download/v#{version}/hlab-darwin-arm64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/NewTurn2017/HarneesLab/releases/download/v#{version}/hlab-darwin-x64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/NewTurn2017/HarneesLab/releases/download/v#{version}/hlab-linux-arm64"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/NewTurn2017/HarneesLab/releases/download/v#{version}/hlab-linux-x64"
      sha256 "PLACEHOLDER_SHA256_LINUX_X64"
    end
  end

  def install
    binary_name = case
    when OS.mac? && Hardware::CPU.arm?
      "hlab-darwin-arm64"
    when OS.mac? && Hardware::CPU.intel?
      "hlab-darwin-x64"
    when OS.linux? && Hardware::CPU.arm?
      "hlab-linux-arm64"
    when OS.linux? && Hardware::CPU.intel?
      "hlab-linux-x64"
    end

    bin.install binary_name => "hlab"
  end

  test do
    # Basic version check - hlab version should exit with 0 on success
    assert_match version.to_s, shell_output("#{bin}/hlab version")
  end
end
