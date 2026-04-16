// Unit tests for the MR URL extractor in cmd/push.
//
// The extractor consumes git-push stderr verbatim. Real GitLab output
// contains a `remote:` prefix and ANSI codes; we keep fixtures close to what
// we've observed from GitLab CE, GitLab.com, and GitHub so the regex stays
// honest.

import { describe, expect, test } from "bun:test";

import { extractMrUrl } from "../../src/cmd/push.ts";

describe("extractMrUrl", () => {
  test("returns null for empty / non-URL stderr", () => {
    expect(extractMrUrl("")).toBeNull();
    expect(extractMrUrl("everything up-to-date")).toBeNull();
    expect(extractMrUrl("fatal: unable to access ...")).toBeNull();
  });

  test("extracts a GitLab merge_requests/new link", () => {
    const stderr = [
      "remote: ",
      "remote: To create a merge request for feature/foo, visit:",
      "remote:   https://gitlab.example.com/group/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Ffoo",
      "remote: ",
      "To gitlab.example.com:group/project.git",
      " * [new branch]      feature/foo -> feature/foo",
      "Branch 'feature/foo' set up to track remote branch 'feature/foo'.",
    ].join("\n");
    expect(extractMrUrl(stderr)).toBe(
      "https://gitlab.example.com/group/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Ffoo",
    );
  });

  test("extracts a GitHub pull/new link", () => {
    const stderr = [
      "remote: ",
      "remote: Create a pull request for 'feature/foo' on GitHub by visiting:",
      "remote:      https://github.com/octocat/Hello-World/pull/new/feature/foo",
      "remote: ",
      "To github.com:octocat/Hello-World.git",
      " * [new branch]      feature/foo -> feature/foo",
    ].join("\n");
    expect(extractMrUrl(stderr)).toBe(
      "https://github.com/octocat/Hello-World/pull/new/feature/foo",
    );
  });

  test("ignores unrelated URLs (help links, docs)", () => {
    const stderr = [
      "remote: See https://docs.gitlab.com/ for help.",
      "To gitlab.example.com:group/project.git",
      " * [new branch]      feature/foo -> feature/foo",
    ].join("\n");
    // Only merge_requests/new and pull/new should match.
    expect(extractMrUrl(stderr)).toBeNull();
  });

  test("prefers the first MR/PR URL when multiple are printed", () => {
    const stderr = [
      "remote:   https://gitlab.example.com/a/b/-/merge_requests/new?foo=1",
      "remote:   https://gitlab.example.com/a/b/-/merge_requests/new?foo=2",
    ].join("\n");
    expect(extractMrUrl(stderr)).toBe(
      "https://gitlab.example.com/a/b/-/merge_requests/new?foo=1",
    );
  });

  test("handles http:// (non-TLS) URLs", () => {
    const stderr =
      "remote:   http://gitlab.local/group/project/-/merge_requests/new?foo=bar\n";
    expect(extractMrUrl(stderr)).toBe(
      "http://gitlab.local/group/project/-/merge_requests/new?foo=bar",
    );
  });
});
