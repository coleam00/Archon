# Homebrew formula for Archon CLI
# To install: brew install coleam00/archon/archon
#
# This formula downloads pre-built binaries from GitHub releases.
# For development, see: https://github.com/coleam00/Archon

class Archon < Formula
  desc "Governed agentic automation engine"
  homepage "https://github.com/coleam00/Archon"
  version "0.13.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "80a4919d01fd08057a7b6e4bd848c73fa5f497554b01c937d1b945eda049d6db"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-x64"
      sha256 "ef4050d566fc31a150a411079290d3674c36153577e2e26d4398ba31b6f104ea"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-arm64"
      sha256 "1c1c71bbe75c486617c22e45b01576207599ac9b7e87833b0080450c5cd506a1"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-x64"
      sha256 "c36248f9110f5844f09a1cdcf97759464d7e8d722b118ee1fc67cd8d61d21a8f"
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
