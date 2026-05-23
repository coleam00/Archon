# Homebrew formula for Archon CLI
# To install: brew install coleam00/archon/archon
#
# This formula downloads pre-built binaries from GitHub releases.
# For development, see: https://github.com/coleam00/Archon

class Archon < Formula
  desc "Remote agentic coding platform - control AI assistants from anywhere"
  homepage "https://github.com/coleam00/Archon"
  version "0.3.12"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "c7d53db2672db5126c83f7cf71f5f604de2c4fbeb01996d5cc49741c69c7c421"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-x64"
      sha256 "315bf0b27a5748da0ac87dcdeb66ea31b4aa20428ef8183b83161f10f456237a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-arm64"
      sha256 "f1897c6cf53a3390b3ab340f79017034efe58b3b6d3d3dded0ce8d263d3782cb"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-x64"
      sha256 "87c36e9f6368c0658028ab6c867b35138bed5ae3f9d3781d699d876f42bcc0e8"
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
