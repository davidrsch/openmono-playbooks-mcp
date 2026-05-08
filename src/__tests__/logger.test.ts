/**
 * Unit tests for the structured JSON logger.
 *
 * Covers:
 *  - All log levels (debug, info, warn, error)
 *  - Log level filtering
 *  - Structured JSON output to stderr
 *  - Extra metadata fields
 *  - setLogLevel
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger, setLogLevel } from "../logger.js";

describe("logger", () => {
  let capturedOutput: string[];

  beforeEach(() => {
    capturedOutput = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
      capturedOutput.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as any);
    // Reset to default level
    setLogLevel("info");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function parseCaptured(): Record<string, unknown>[] {
    return capturedOutput
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line.trim()));
  }

  describe("log levels", () => {
    it("writes info messages to stderr as JSON", () => {
      logger.info("test-component", "test message");
      expect(capturedOutput.length).toBe(1);
      const entry = JSON.parse(capturedOutput[0].trim());
      expect(entry.level).toBe("info");
      expect(entry.component).toBe("test-component");
      expect(entry.message).toBe("test message");
      expect(entry.timestamp).toBeDefined();
      expect(typeof entry.timestamp).toBe("string");
    });

    it("writes warn messages to stderr as JSON", () => {
      logger.warn("loader", "deprecated config");
      expect(capturedOutput.length).toBe(1);
      const entry = JSON.parse(capturedOutput[0].trim());
      expect(entry.level).toBe("warn");
      expect(entry.component).toBe("loader");
      expect(entry.message).toBe("deprecated config");
    });

    it("writes error messages to stderr as JSON", () => {
      logger.error("executor", "failed to persist", { runId: "abc-123" });
      expect(capturedOutput.length).toBe(1);
      const entry = JSON.parse(capturedOutput[0].trim());
      expect(entry.level).toBe("error");
      expect(entry.component).toBe("executor");
      expect(entry.message).toBe("failed to persist");
      expect(entry.runId).toBe("abc-123");
    });

    it("suppresses debug messages when log level is info", () => {
      logger.debug("test", "should not appear");
      expect(capturedOutput.length).toBe(0);
    });

    it("outputs debug messages when log level is debug", () => {
      setLogLevel("debug");
      logger.debug("test", "debug details here");
      expect(capturedOutput.length).toBe(1);
      const entry = JSON.parse(capturedOutput[0].trim());
      expect(entry.level).toBe("debug");
      expect(entry.message).toBe("debug details here");
    });
  });

  describe("extra metadata", () => {
    it("merges extra fields into the JSON entry", () => {
      logger.info("executor", "run started", {
        runId: "run-001",
        playbookName: "deploy",
        stepCount: 5,
      });
      const entry = JSON.parse(capturedOutput[0].trim());
      expect(entry.runId).toBe("run-001");
      expect(entry.playbookName).toBe("deploy");
      expect(entry.stepCount).toBe(5);
    });

    it("handles empty extra", () => {
      logger.info("test", "no extras");
      const entry = JSON.parse(capturedOutput[0].trim());
      // Only standard fields
      const keys = Object.keys(entry).sort();
      expect(keys).toEqual(["component", "level", "message", "timestamp"]);
    });

    it("outputs valid JSON with special characters in message", () => {
      logger.error("parser", 'Invalid JSON in playbook "test"');
      const entry = JSON.parse(capturedOutput[0].trim());
      expect(entry.message).toContain('"test"');
    });
  });

  describe("log level filtering", () => {
    it("shows info, warn, error at info level", () => {
      logger.debug("x", "d");
      logger.info("x", "i");
      logger.warn("x", "w");
      logger.error("x", "e");
      const entries = parseCaptured();
      expect(entries.length).toBe(3);
      expect(entries.map((e) => e.level)).toEqual(["info", "warn", "error"]);
    });

    it("shows only warn and error at warn level", () => {
      setLogLevel("warn");
      logger.info("x", "i");
      logger.warn("x", "w");
      logger.error("x", "e");
      const entries = parseCaptured();
      expect(entries.length).toBe(2);
      expect(entries.map((e) => e.level)).toEqual(["warn", "error"]);
    });

    it("shows only errors at error level", () => {
      setLogLevel("error");
      logger.info("x", "i");
      logger.warn("x", "w");
      logger.error("x", "e");
      const entries = parseCaptured();
      expect(entries.length).toBe(1);
      expect(entries[0].level).toBe("error");
    });

    it("shows all levels at debug level", () => {
      setLogLevel("debug");
      logger.debug("x", "d");
      logger.info("x", "i");
      logger.warn("x", "w");
      logger.error("x", "e");
      const entries = parseCaptured();
      expect(entries.length).toBe(4);
      expect(entries.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
    });
  });

  describe("timestamp format", () => {
    it("outputs ISO 8601 timestamps", () => {
      logger.info("x", "timestamp test");
      const entry = JSON.parse(capturedOutput[0].trim());
      const timestamp = entry.timestamp as string;
      // ISO 8601 regex
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Should be a valid date
      expect(new Date(timestamp).getTime()).not.toBeNaN();
    });
  });

  describe("concurrent logging", () => {
    it("produces one line per call (no interleaving within JSON)", () => {
      logger.info("a", "msg-a");
      logger.info("b", "msg-b");
      logger.info("c", "msg-c");
      const lines = capturedOutput.filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(3);
      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line.trim())).not.toThrow();
      }
    });
  });
});
