# Homebrew formula for Archon CLI
# To install: brew install coleam00/archon/archon
#
# This formula downloads pre-built binaries from GitHub releases.
# For development, see: https://github.com/coleam00/Archon

class Archon < Formula
  desc "Governed agentic automation engine"
  homepage "https://github.com/coleam00/Archon"
  version "0.17.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "9c1b3800ea12003fede9c8425ebfc96a9148fbeb6effad0161ddd0797ef0ca8c"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-darwin-x64"
      sha256 "97315d4bf8909fd414091e910ff118b0a3d601e89269d629651911a1d260f695"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-arm64"
      sha256 "1271228e538c0e5051cbe1ca7e8efbf131c7dcfa6f067e1e9e7a33bb29a34edd"
    end
    on_intel do
      url "https://github.com/coleam00/Archon/releases/download/v#{version}/archon-linux-x64"
      sha256 "97a26efd2fbd441b27693ce0f2349d2f8066c1007c25064c772b12714bc3b09e"
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
