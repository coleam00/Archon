# Homebrew formula for Archon CLI
# To install: brew install coleam00/archon/archon
#
# This formula downloads pre-built binaries from GitHub releases.
# For development, see: https://github.com/coleam00/Archon

class Archon < Formula
  desc "Governed agentic automation engine"
  homepage "https://github.com/coleam00/Archon"
  version "0.15.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "cb5993f85d2ca62c571172874b5e4a3cff6631afa7ec37ff77b824a730666116"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-x64"
      sha256 "35872630d8123e84988bf6eff8202a79066bb9ba98277393b4f23ef45efb48fc"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-arm64"
      sha256 "2ef52984544c5fb7cd0325c9144cf3e81777571cc3d3c8388ac4a8245ac4934b"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-x64"
      sha256 "efdec07fe56ba8d3a12c5fb502a14224c178db1a8405cead4e81030e22f89722"
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
