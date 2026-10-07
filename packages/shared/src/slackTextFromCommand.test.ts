import { describe, expect, it } from "vite-plus/test";
import { slackTextFromCommand } from "./slackTextFromCommand.ts";

describe("slackTextFromCommand", () => {
  it("reads the text piped from printf into dm-send", () => {
    expect(
      slackTextFromCommand(
        `cd ~/bots && printf '%s' 'Deploy is live. It'"'"'s green.' | bin/dm-send --thread 1.2 >/dev/null && echo sent`,
      ),
    ).toBe("Deploy is live. It's green.");
  });

  it("reads double-quoted escapes and single-quoted text", () => {
    expect(slackTextFromCommand(`printf '%s' "Say \\"hi\\"" | dm-send`)).toBe('Say "hi"');
    expect(slackTextFromCommand(`printf '%s' 'Line one\nLine two' | /x/bin/dm-send 2>&1`)).toBe(
      "Line one\nLine two",
    );
  });

  it("unwraps the shell -c wrapper some providers add", () => {
    expect(
      slackTextFromCommand(`/bin/zsh -lc "printf '%s' 'Wrapped hello' | /x/bin/dm-send"`),
    ).toBe("Wrapped hello");
  });

  it("reads heredoc bodies fed to dm-send or piped from cat", () => {
    expect(slackTextFromCommand("bin/dm-send --long <<'EOF'\nFirst\nSecond\nEOF\necho done")).toBe(
      "First\nSecond",
    );
    expect(slackTextFromCommand("cat <<EOF | dm-send\nHello\nEOF")).toBe("Hello");
  });

  it("ignores commands that only mention dm-send", () => {
    expect(slackTextFromCommand("bin/dm-send --help 2>&1 | head -5")).toBeNull();
    expect(slackTextFromCommand(`grep -n "dm-send" log.md; bin/dm-send --check`)).toBeNull();
    expect(slackTextFromCommand(`printf '%s' "unterminated | dm-send`)).toBeNull();
  });
});
