package main

// "Is there a newer release?" — asked of GitHub at most every updateCheckEvery,
// with the answer cached, so a launch normally costs no request at all and an
// offline one costs nothing either. It runs while the target is probed, and
// never holds a launch up for longer than updateWait.
//
// Only a launcher released from a tag asks: a dev build has no release to be
// behind, and its maintainer knows what is newer.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	updateCheckEvery = 12 * time.Hour
	updateWait       = 3 * time.Second
	// noUpdateCheckEnv turns the check off, like --no-update-check.
	noUpdateCheckEnv = "WEBTMUX_LAUNCH_NO_UPDATE_CHECK"
)

// releaseInfo is the little the launcher needs about one release.
type releaseInfo struct {
	Tag       string    `json:"tag"`
	Published time.Time `json:"published"`
	Checked   time.Time `json:"checked"`
}

// githubAPI is api.github.com unless a test points it elsewhere.
var githubAPI = "https://api.github.com"

// fetchRelease asks GitHub's API for one release: "latest" or a tag. No auth:
// the repo is public, and 60 unauthenticated requests an hour is far more than
// a 12-hourly check needs.
func fetchRelease(ctx context.Context, owner, repo, which string) (releaseInfo, error) {
	u := fmt.Sprintf("%s/repos/%s/%s/releases/latest", githubAPI, owner, repo)
	if which != "latest" {
		u = fmt.Sprintf("%s/repos/%s/%s/releases/tags/%s", githubAPI, owner, repo, which)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return releaseInfo{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return releaseInfo{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return releaseInfo{}, fmt.Errorf("%s from %s", resp.Status, u)
	}
	var body struct {
		TagName     string    `json:"tag_name"`
		PublishedAt time.Time `json:"published_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return releaseInfo{}, err
	}
	if body.TagName == "" {
		return releaseInfo{}, errors.New("no tag_name in " + u)
	}
	return releaseInfo{Tag: body.TagName, Published: body.PublishedAt, Checked: time.Now()}, nil
}

// cachedRelease returns the cached answer for which ("latest" or a tag) when it
// is younger than maxAge, else asks GitHub and caches that. A failed request
// falls back to a stale cached answer: an old "v0.4.0 is out" is still true.
func cachedRelease(ctx context.Context, cacheRoot, owner, repo, which string, maxAge time.Duration) (releaseInfo, error) {
	file := filepath.Join(cacheRoot, "release-"+which+".json")
	var cached releaseInfo
	if b, err := os.ReadFile(file); err == nil && json.Unmarshal(b, &cached) == nil && cached.Tag != "" {
		if time.Since(cached.Checked) < maxAge {
			return cached, nil
		}
	}
	got, err := fetchRelease(ctx, owner, repo, which)
	if err != nil {
		if cached.Tag != "" {
			return cached, nil
		}
		return releaseInfo{}, err
	}
	if b, err := json.Marshal(got); err == nil {
		if os.MkdirAll(cacheRoot, 0o755) == nil {
			_ = os.WriteFile(file, b, 0o644)
		}
	}
	return got, nil
}

// releaseDate is when a tag was published, for naming an older running build
// that carries no build stamp of its own. A tag's release never changes date,
// so a cached answer never expires. Zero when it cannot be found out quickly.
func releaseDate(cacheRoot, tag string) time.Time {
	if !isTag(tag) || RepoOwner == "" || RepoName == "" {
		return time.Time{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), updateWait)
	defer cancel()
	r, err := cachedRelease(ctx, cacheRoot, RepoOwner, RepoName, tag, 100*365*24*time.Hour)
	if err != nil {
		return time.Time{}
	}
	return r.Published
}

// newerTag reports whether tag a is a later release than b. Both are vX.Y.Z,
// optionally with a pre-release suffix, which sorts before the release itself.
func newerTag(a, b string) bool {
	pa, sa, okA := splitTag(a)
	pb, sb, okB := splitTag(b)
	if !okA || !okB {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	switch {
	case sa == sb:
		return false
	case sa == "":
		return true // v0.4.0 is newer than v0.4.0-rc1
	case sb == "":
		return false
	}
	return sa > sb
}

func splitTag(t string) (nums [3]int, suffix string, ok bool) {
	if !isTag(t) {
		return nums, "", false
	}
	core, suffix, _ := strings.Cut(strings.TrimPrefix(t, "v"), "-")
	for i, part := range strings.SplitN(core, ".", 3) {
		n, err := strconv.Atoi(part)
		if err != nil {
			return nums, "", false
		}
		nums[i] = n
	}
	return nums, suffix, true
}

// launcherAsset is this launcher's own release asset name.
func launcherAsset() string {
	name := "webtmux-launch-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// updateNotice is the message for a newer release, or "" when there is none.
func updateNotice(current string, latest releaseInfo) []string {
	if !newerTag(latest.Tag, current) {
		return nil
	}
	when := ""
	if !latest.Published.IsZero() {
		when = " (released " + day(latest.Published) + ")"
	}
	return []string{
		fmt.Sprintf("update available: webtmux %s%s — this launcher is %s", latest.Tag, when, current),
		fmt.Sprintf("  recommended: download %s from https://github.com/%s/%s/releases/latest",
			launcherAsset(), RepoOwner, RepoName),
	}
}

// startUpdateCheck begins the check in the background and returns a function
// that yields its notice: it waits for the answer only until updateWait has
// passed since the start, then gives up silently for this launch.
func startUpdateCheck(o *options, getenv func(string) string, cacheRoot string) func() []string {
	if o.noUpdateCheck || getenv(noUpdateCheckEnv) != "" || !isTag(Version) || RepoOwner == "" || RepoName == "" {
		return func() []string { return nil }
	}
	deadline := time.Now().Add(updateWait)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	done := make(chan []string, 1)
	go func() {
		defer cancel()
		latest, err := cachedRelease(ctx, cacheRoot, RepoOwner, RepoName, "latest", updateCheckEvery)
		if err != nil {
			done <- nil
			return
		}
		done <- updateNotice(Version, latest)
	}()
	return func() []string {
		select {
		case n := <-done:
			return n
		case <-time.After(time.Until(deadline)):
			return nil
		}
	}
}
