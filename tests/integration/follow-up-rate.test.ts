import { describe, expect, it } from "vitest";
import { followUp } from "@/lib/llm/tasks/follow-up";
import type { ExperienceLevel, QuestionType } from "@/lib/supabase/types";

/**
 * The follow-up rate, measured against the real providers on a fixed corpus:
 * every question has one strong answer (correct approach, stated
 * complexity, named edge cases — or the type's equivalent) and one weak one.
 * A strong answer should draw no probe; a weak one should.
 *
 * Opt-in: it spends ~2 × corpus size provider calls per run.
 *   FOLLOW_UP_RATE=1 npm run test:integration -- follow-up-rate
 *
 * The thresholds at the bottom are the contract. They were set after the
 * task was tuned on this corpus; if a model change moves the rate, this is
 * what says so.
 */

interface Case {
  type: QuestionType;
  level: ExperienceLevel;
  question: string;
  strong: string;
  weak: string;
}

export const CORPUS: Case[] = [
  {
    type: "dsa",
    level: "fresher",
    question:
      "Given a sorted array of integers and a target sum, find whether any two numbers add up to the target. For example, with [1,2,4,6,10] and target 8, the pair (2,6) works. Walk me through your approach, then its time and space complexity, and what could break it.",
    strong:
      "Because the array is sorted I'd use two pointers, one at each end. If the sum is too small I move the left pointer right, if too big I move the right pointer left, and I stop when they meet or I hit the target. That's O(n) time and O(1) extra space, one pass. Edge cases: fewer than two elements returns false straight away; duplicates are fine because the pointers never reuse an index; and if the values can be large I'd watch for overflow in the sum, so I'd compare target minus one side rather than adding.",
    weak: "I would loop through the array and check each element until I find what I need.",
  },
  {
    type: "dsa",
    level: "fresher",
    question:
      "Given a binary tree where each node holds an integer, return the length of the longest downward path with strictly increasing values from parent to child. For example, root 2, left child 3, left-left child 5 gives 3. Walk me through your approach and its complexity.",
    strong:
      "Depth-first search carrying the length of the current increasing run. At each node, if its value is greater than its parent's, the run is parent's run plus one, otherwise it restarts at one; I track the maximum seen. Each node is visited once, so O(n) time, and the recursion stack is O(h) where h is the height, which is O(n) worst case for a skewed tree — I'd switch to an explicit stack if that mattered. Edge cases: an empty tree returns 0, a single node returns 1, equal values do not extend the run because it has to be strictly increasing.",
    weak: "I'd go through the tree and keep a counter of how many times it goes up.",
  },
  {
    type: "dsa",
    level: "junior",
    question:
      "Given an array of positive integers and an integer k, find the length of the longest contiguous subarray whose sum does not exceed k. For instance, [2,1,5,1,3,2] with k=7 gives 3. Explain your solution, its complexity, and what input patterns could break it.",
    strong:
      "Sliding window. Because every value is positive, the running sum only grows as the right end extends and only shrinks as the left end retracts, so I extend right, and while the sum exceeds k I shrink from the left, recording the best window each step. Each index enters and leaves the window once, so O(n) time and O(1) space. Edge cases: if every element exceeds k the answer is 0; k of 0 gives 0; an empty array gives 0. The thing that breaks it is a zero or negative value — then the monotonic argument fails and I'd need prefix sums with a search instead.",
    weak: "I think you could use a hash map for this and it would be O(n).",
  },
  {
    type: "dsa",
    level: "intern",
    question:
      "Given a string, return whether it is a palindrome ignoring case and non-letters. For example, 'A man, a plan, a canal: Panama' is one. Walk me through your approach and its complexity.",
    strong:
      "Two pointers from both ends. I skip any character that is not a letter or digit on either side, compare the two lowercased characters, and move inward; the first mismatch returns false, meeting in the middle returns true. O(n) time, O(1) extra space since I never build a new string. Edge cases: the empty string and a single character are palindromes; a string of only punctuation is a palindrome by that definition; and mixed case has to be normalised before comparing.",
    weak: "Reverse the string and see if it's the same, I guess.",
  },
  {
    type: "cs_fundamentals",
    level: "fresher",
    question: "What actually happens when a process reads a virtual address whose page is not in memory, and why do systems bother with that mechanism?",
    strong:
      "The MMU walks the page table, finds the present bit clear, and raises a page fault. The kernel's handler checks the address is valid for the process; if it is, it finds a free frame, or evicts one under the replacement policy, reads the page in from disk or the swap area, updates the page table entry, and resumes the faulting instruction. Systems do it so processes can use more memory than is physically present, so each process gets an isolated address space, and so pages can be loaded lazily — a program touching a tenth of its binary pays for a tenth. The cost is that a fault is orders of magnitude slower than a hit, which is why thrashing is so visible.",
    weak: "It's when the memory isn't there so the OS has to get it. It's for virtual memory.",
  },
  {
    type: "cs_fundamentals",
    level: "junior",
    question: "Why can adding an index to a database table make some queries faster and others slower? Be concrete.",
    strong:
      "An index is a separate B-tree ordered on the indexed columns, so a lookup or a range scan on those columns goes from a full table scan to a logarithmic descent plus a short walk — that's the win. The cost is that every insert, update of the indexed column, and delete has to maintain the tree too, so write-heavy tables pay on every write, and each extra index multiplies that. Reads can also get slower when the index is used badly: a query that touches most of the table through the index does a random I/O per row instead of a sequential scan, and the planner will sometimes pick the index when statistics are stale. Concretely, an index on a low-cardinality column like a boolean rarely helps and always costs.",
    weak: "Indexes make lookups faster but they take space, so it depends.",
  },
  {
    type: "system_design",
    level: "fresher",
    question: "Design a URL shortener: a service that turns a long URL into a short one and redirects when the short one is visited. Walk me through the components, the data flow, and one trade-off.",
    strong:
      "Requirements first: create a short code for a URL, redirect on visit, and reads vastly outnumber writes — say a hundred to one. Components: an API service, a database keyed on the short code holding the long URL, and a cache in front for redirects. Create flow: the service generates a code — I'd use a counter encoded in base62 rather than hashing, because hashing has to handle collisions and a counter does not — stores the row, returns the code. Redirect flow: look up the code in the cache, fall through to the database on a miss, return a 302. The trade-off I'd call out is 301 versus 302: a 301 lets browsers cache the redirect, which cuts our load but means we lose the click analytics and cannot change the target later; I'd pick 302 and rely on the cache for load. Scaling reads is the cache and read replicas; the counter is the one thing that has to be coordinated, so I'd hand out ranges to each service instance.",
    weak: "A database with the URLs and a hash function to make the short one. Then you redirect.",
  },
  {
    type: "system_design",
    level: "junior",
    question: "Design a rate limiter for a public API that has to hold a limit per client across several server instances. Components, data flow, and one trade-off.",
    strong:
      "The limit has to be shared, so the counters live outside the instances — Redis is the usual choice. Each request does an atomic increment on a key of client ID plus the current window, with an expiry on the key, and is rejected if the count is over the limit; a Lua script or MULTI keeps the check-and-increment atomic. Fixed windows are simple but allow a burst of twice the limit across a window boundary, so I'd use a sliding log or a token bucket: the bucket stores tokens and a last-refill timestamp per client, refilled on read — one key, O(1), and it smooths bursts. The trade-off is what to do when Redis is unreachable: fail open and let everything through, or fail closed and reject everything. For a public API I'd fail open with an alarm, because a rate limiter outage should not become an API outage; for a billing-sensitive one I'd fail closed.",
    weak: "Keep a count per user and reject when it's too high. Store it somewhere shared.",
  },
  {
    type: "behavioural",
    level: "fresher",
    question: "Tell me about a time you disagreed with a decision your team made. What did you do?",
    strong:
      "In my final-year project we were about to rewrite our data layer two weeks before the demo because one teammate wanted to switch databases. I disagreed: I wrote up the three bugs the switch was meant to fix and showed two of them were in our query code, not the database, with the failing cases. I proposed fixing those and postponing the switch, and I offered to take both fixes myself. The team agreed; I fixed them in three days, the demo went ahead on the original stack, and we shipped the switch the following term with a proper test suite. What I took from it is to argue with evidence and to attach an offer to do the work.",
    weak: "I usually just go along with the team, but sometimes I say what I think and we discuss it.",
  },
  {
    type: "behavioural",
    level: "junior",
    question: "Describe a production incident you were involved in and your part in resolving it.",
    strong:
      "A payments queue backed up on a Friday afternoon — orders were accepted but not charged. I was on call. I confirmed from the queue depth graph that consumers had stopped, found from the consumer logs that a deploy an hour earlier had introduced a schema mismatch on one message type, and rolled that deploy back, which got consumers moving in about twenty minutes. Then I wrote a replay script for the eight hundred messages that had dead-lettered and ran it with a colleague watching the charge totals. Post-incident, I added a contract test between producer and consumer so a mismatch fails in CI rather than in production, and we changed the deploy window. Total impact was about ninety minutes of delayed charges and no double charges.",
    weak: "There was an outage once and we all jumped on a call and figured it out together.",
  },
];

const enabled = Boolean(process.env.FOLLOW_UP_RATE);

describe.skipIf(!enabled)("follow-up rate on the corpus (real providers)", () => {
  const REPEATS = Number(process.env.FOLLOW_UP_REPEATS ?? 1);

  it("strong answers pass clean, weak answers get caught", async () => {
    const rows: Array<{ type: string; strong: number; weak: number; probes: string[] }> = [];
    let strongProbed = 0;
    let weakProbed = 0;
    const total = CORPUS.length * REPEATS;

    for (const c of CORPUS) {
      const row = { type: c.type, strong: 0, weak: 0, probes: [] as string[] };
      for (let r = 0; r < REPEATS; r += 1) {
        const s = await followUp({ type: c.type, level: c.level, question: c.question, answer: c.strong });
        const w = await followUp({ type: c.type, level: c.level, question: c.question, answer: c.weak });
        if (s.probe) {
          row.strong += 1;
          strongProbed += 1;
          row.probes.push(`STRONG→ ${s.probe}`);
        }
        if (w.probe) {
          row.weak += 1;
          weakProbed += 1;
        } else {
          row.probes.push("WEAK→ (no probe)");
        }
      }
      rows.push(row);
    }

    const pct = (n: number) => `${Math.round((100 * n) / total)}%`;
    const report = [
      "",
      `follow-up rate over ${CORPUS.length} questions × ${REPEATS}:`,
      `  strong answers probed: ${strongProbed}/${total} (${pct(strongProbed)})   — want ~0%`,
      `  weak answers probed:   ${weakProbed}/${total} (${pct(weakProbed)})   — want ~100%`,
      ...rows.map((r) => `  ${r.type.padEnd(16)} strong ${r.strong}/${REPEATS}  weak ${r.weak}/${REPEATS}${r.probes.length ? "\n      " + r.probes.join("\n      ") : ""}`),
      "",
    ].join("\n");
    console.log(report);

    // The contract. One miss either way on a ten-question corpus is noise;
    // two is a change in the task or the model.
    expect(strongProbed, `strong answers probed:\n${report}`).toBeLessThanOrEqual(Math.ceil(total * 0.1));
    expect(weakProbed, `weak answers missed:\n${report}`).toBeGreaterThanOrEqual(Math.floor(total * 0.9));
  }, 600_000);
});
