# Homebrew formula for Archon CLI
# To install: brew install coleam00/archon/archon
#
# This formula downloads pre-built binaries from GitHub releases.
# For development, see: https://github.com/coleam00/Archon

class Archon < Formula
  desc "Governed agentic automation engine"
  homepage "https://github.com/coleam00/Archon"
  version "0.13.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "efb4f3d86c13356e73626f3082b15d3f4c58cdbd9b16a98c574af85276cc6942"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-x64"
      sha256 "50fabc0fe0ea53d6df6458f198bde3adab8a3b95531825103a6e34f4fd1ce265"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-arm64"
      sha256 "c872fccca4d9ff6aca6d8ca9900b059f89dd11e558920a57d22c87d48a36fe40"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-x64"
      sha256 "a47bda6c9d89277fb9298f1bfce6f336e3b9d054462ab69179ba3f7d7c8ac1f5"
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
