/**
 * Blueprint: business toolkits from the product factory's offline catalogue (see factory.ts). Each concept is a
 * complete, hand-written pack of editable files (Markdown guides, checklists and templates, CSV trackers); nothing is
 * model-generated or padded. start-here.md is built from the file list so it always explains every file.
 *
 * Wording avoids legal, tax and financial topics on purpose: these toolkits organise work, they do not advise.
 */

import type { Opportunity } from "../types.js";
import { type Blueprint, csv, type Pitch, type ProductFile } from "./common.js";

export interface Concept {
  readonly id: string;
  readonly name: string;
  readonly audience: string;
  readonly problem: string;
  readonly offer: string;
  /** Opening line for short social posts (plain, no claims). */
  readonly hook: string;
  readonly pitch: Pitch;
  /** Owner-catalogue ratings (0..1), stated assumptions rather than market data. */
  readonly ratings: { readonly usefulness: number; readonly simplicity: number; readonly monetisation: number };
  readonly reasons: { readonly usefulness: string; readonly simplicity: string; readonly monetisation: string };
  readonly price: number;
  readonly priceRationale: string;
  readonly setup: readonly string[];
  readonly files: readonly ProductFile[];
  /** Set for factory-made concepts (AI or mock): where the content came from, for labelling and review. */
  readonly origin?: { readonly mode: "ai" | "mock-demo"; readonly model: string; readonly run: string; readonly idea: string; readonly imageBrief: string; readonly differentiation: string; readonly risks: readonly string[]; readonly assumptions: readonly string[] };
}

const start = (c: Omit<Concept, "files"> & { files: readonly ProductFile[] }): ProductFile => ({
  name: "start-here.md", template: false, description: "Start here: what is included and how to set it up", text: `# ${c.name}: start here

${c.offer}

## What is included

| File | What it is | Open it with |
|---|---|---|
${c.files.map((f) => `| \`${f.name}\` | ${f.description} | ${f.name.endsWith(".csv") ? "Excel, Google Sheets, Numbers or LibreOffice" : f.name.endsWith(".html") ? "Any web browser (works offline; print or save as PDF)" : "Any text editor or word processor"} |`).join("\n")}

## Setup

${c.setup.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Notes

- Words in double square brackets are fields for you to fill in; delete the example rows in the CSV files when you start.
- The CSV files contain no formulas, so they open safely in any spreadsheet program.
- Everything is plain text: keep your own copy, rename the files and change anything to suit how you work.
`,
});

export const concept = (c: Omit<Concept, "files"> & { files: readonly ProductFile[] }): Concept => ({ ...c, files: [start(c), ...c.files] });

export const CONCEPTS: readonly Concept[] = [
  concept({
    id: "client-onboarding-kit", name: "Client onboarding kit", audience: "freelancers and small studios",
    problem: "starting new client projects without missing information, access or agreed expectations",
    offer: "A repeatable onboarding routine for new clients: intake questionnaire, welcome pack, kickoff agenda, access checklist and an onboarding tracker.",
    hook: "New client said yes? Start the project with the brief, logins and expectations sorted from day one.",
    pitch: {
      headline: "Start every client project with everything you need",
      subheadline: "For freelancers and small studios: an intake questionnaire, welcome pack, kickoff agenda and trackers that make onboarding the same, every time.",
      benefits: ["Collect the brief, contacts and goals with one questionnaire", "Send a clear welcome pack so clients know how you work", "Run a focused kickoff call with a ready agenda", "Track every new client and every login you are waiting for"],
      faq: [
        { q: "What format is it in?", a: "Markdown documents (open in any text editor or word processor) and CSV trackers (open in any spreadsheet program). No accounts or software to install." },
        { q: "Can I change the wording?", a: "Yes. Every file is plain text and meant to be edited to match your services and tone." },
        { q: "Does it replace a written agreement with my client?", a: "No. It organises onboarding; agree your terms with your client separately." },
      ],
    },
    ratings: { usefulness: 0.8, simplicity: 0.85, monetisation: 0.7 },
    reasons: { usefulness: "every new client needs the same onboarding steps; the kit turns them into a routine", simplicity: "Markdown and CSV only, no calculator or scripts", monetisation: "same audience as the live invoicing kit, so it can be offered to the same buyers as a companion" },
    price: 9, priceRationale: "GBP 9: below the live GBP 12 invoicing kit because it has fewer files and no calculator; a hypothesis to test, not based on market price data.",
    setup: ["Read `onboarding-checklist.md` once to see the whole routine.", "Edit `welcome-pack.md` and `client-intake-questionnaire.md` with your services, hours and contact details; save them as your own masters.", "Open `onboarding-tracker.csv`, delete the example row and add each new client when they say yes.", "For each new client: send the questionnaire, book the kickoff with `kickoff-call-agenda.md`, and request logins with `access-checklist.csv`."],
    files: [
      { name: "onboarding-checklist.md", template: false, description: "The onboarding routine, stage by stage, as a tick-box checklist", text: `# Client onboarding checklist

## 1. When the client says yes

- [ ] Add the client to onboarding-tracker.csv with today's date
- [ ] Confirm the agreed scope, price and start date in writing
- [ ] Send the client intake questionnaire with a reply-by date
- [ ] Send your welcome pack with how you work and how to reach you

## 2. Before the kickoff call

- [ ] Read the questionnaire answers and note anything unclear
- [ ] Book a 45-minute kickoff call and send the agenda in advance
- [ ] List every login, file and asset you will need in access-checklist.csv
- [ ] Create the project folder and name it the same way every time

## 3. Kickoff call

- [ ] Agree the main contact and who signs off the work
- [ ] Confirm the first milestone and its date
- [ ] Agree how and how often you will send progress updates
- [ ] Walk through the access checklist and agree who sends what

## 4. First week

- [ ] Send a written summary of the kickoff decisions within one day
- [ ] Chase any missing access after three working days
- [ ] Share the first progress update on the agreed day
- [ ] Mark onboarding complete in the tracker when all access is received
` },
      { name: "client-intake-questionnaire.md", template: true, description: "Questionnaire to send each new client before the kickoff call", text: `# New project questionnaire: [[Your business name]]

Thank you for choosing to work with [[Your business name]]. Please answer the questions below by [[reply-by date]].
Short answers are fine; we will go through them together at the kickoff call.

## About you

- Your name, role and the best way to reach you
- Who else should receive project updates, and their email addresses
- Who gives the final approval on the work

## About the project

- In two or three sentences, what do you want this project to achieve?
- What would make you say the project was a success?
- Are there dates or events the work must be ready for?
- Is there anything that has not worked well in similar projects before?

## Materials and access

- Which files, brand guidelines or examples should we look at first?
- Which accounts or tools will we need access to?
- Who in your team can give us that access?

## Working together

- How do you prefer to receive updates: email, call or shared document?
- Which days and times are best for meetings?
- Is there anything else we should know before we start?
` },
      { name: "welcome-pack.md", template: true, description: "Welcome letter explaining how you work, to adapt and send to each client", text: `# Welcome to [[Your business name]]

Hello [[Client name]],

Thank you for starting [[Project name]] with us. This short pack explains how the project will run.

## What happens next

- Please return the project questionnaire by [[reply-by date]]
- We will meet for the kickoff call on [[kickoff date]]
- Your first progress update will arrive on [[first update date]]

## How we work

- Working hours: [[days and hours]]
- The quickest way to reach us: [[email or phone]]
- We reply to messages within [[response time]] on working days
- Changes to the agreed scope are confirmed in writing before work starts

## What we need from you

- One main contact who can answer questions and approve work
- Access to the accounts and files listed in our access checklist
- Feedback on each draft within [[feedback time]]

We look forward to working with you.

[[Your name]]
` },
      { name: "kickoff-call-agenda.md", template: false, description: "A 45-minute kickoff call agenda with the decisions to record", text: `# Kickoff call agenda (45 minutes)

## 1. Introductions (5 minutes)

- Confirm who is on the call and each person's role
- Agree who is the main contact and who approves the work

## 2. Goals and success (10 minutes)

- Read back the goals from the questionnaire and check they are still right
- Agree what a successful result looks like at the end

## 3. Scope and milestones (15 minutes)

- Walk through what is included and what is not included
- Confirm the first milestone, its date and what will be delivered
- Agree how changes to the scope will be requested and confirmed

## 4. Access and materials (10 minutes)

- Go through the access checklist line by line
- Agree a date by which all access will be sent

## 5. Communication (5 minutes)

- Agree the day and format of regular progress updates
- Confirm the date of the next check-in

## After the call

- Send a written summary of the decisions within one working day
- Update the onboarding tracker and the access checklist
` },
      { name: "onboarding-tracker.csv", template: true, description: "One row per new client: questionnaire, kickoff, access and status", text: csv([["Client", "Project", "Start date", "Questionnaire sent", "Questionnaire received", "Kickoff date", "Welcome pack sent", "All access received", "Status", "Notes"], ["Example Ltd", "Website refresh", "2026-01-12", "2026-01-05", "2026-01-08", "2026-01-12", "2026-01-05", "2026-01-15", "Complete", "Delete this example row"]]) },
      { name: "access-checklist.csv", template: true, description: "Every login, file and asset to request from a client, with dates", text: csv([["Client", "What is needed", "Why it is needed", "Who provides it", "Requested on", "Received on", "Notes"], ["Example Ltd", "Website admin login", "To update pages", "Client's office manager", "2026-01-05", "2026-01-09", "Delete this example row"], ["Example Ltd", "Brand guidelines and logo files", "To keep the design consistent", "Client's marketing lead", "2026-01-05", "2026-01-06", "Delete this example row"]]) },
    ],
  }),
  concept({
    id: "proposal-quote-kit", name: "Proposal and quote kit", audience: "freelancers and small service businesses",
    problem: "writing clear proposals and quotes quickly without forgetting scope details",
    offer: "A proposal template, a quote worksheet, a scope checklist and a follow-up plan, so every proposal is complete and sent on time.",
    hook: "Writing every proposal from a blank page? Use one structure, check the scope, then follow up on a set schedule.",
    pitch: {
      headline: "Send clear proposals and quotes in less time",
      subheadline: "For freelancers and small service businesses: a proposal template, quote worksheet, scope checklist and follow-up plan.",
      benefits: ["Write each proposal from one structured template", "Price each line of work in a simple quote worksheet", "Check scope, exclusions and dates before you send", "Follow up every open proposal on a set schedule"],
      faq: [
        { q: "What format is it in?", a: "Markdown documents and CSV worksheets: they open in any text editor and any spreadsheet program." },
        { q: "Does the worksheet calculate totals?", a: "No. It contains no formulas, so it opens safely anywhere; add a total column in your spreadsheet program if you want one." },
      ],
    },
    ratings: { usefulness: 0.75, simplicity: 0.8, monetisation: 0.7 },
    reasons: { usefulness: "proposals are written often and a missing scope detail causes disputes later", simplicity: "Markdown and CSV only", monetisation: "fits buyers of the invoicing kit (the step before invoicing)" },
    price: 9, priceRationale: "GBP 9: smaller than the live GBP 12 invoicing kit; a hypothesis to test, not based on market price data.",
    setup: ["Edit `proposal-template.md` with your business name, services and usual wording; keep it as your master.", "Before each proposal, work through `scope-checklist.md`.", "List each line of work in `quote-worksheet.csv` and copy the lines into the proposal.", "Add each sent proposal to `proposal-log.csv` and follow up using `follow-up-plan.md`."],
    files: [
      { name: "proposal-template.md", template: true, description: "Proposal template with every section a client expects", text: `# Proposal: [[Project name]] for [[Client name]]

Prepared by [[Your business name]] on [[date]]. Valid until [[valid-until date]].

## Your goals

- [[The main goal in the client's own words]]
- [[What success looks like at the end of the project]]

## What we will deliver

- [[Deliverable 1, with what is included]]
- [[Deliverable 2, with what is included]]

## What is not included

- [[Work that is out of scope, stated plainly]]

## Timeline

- Start date: [[start date]]
- First milestone: [[milestone and date]]
- Final delivery: [[delivery date]]

## Price

- [[Copy the lines from your quote worksheet]]
- Total: [[total]]

## Next steps

- Reply to accept this proposal by [[valid-until date]]
- We will then send the welcome details and book a kickoff call
` },
      { name: "scope-checklist.md", template: false, description: "Questions to answer before sending any proposal", text: `# Scope checklist

## Before you write

- [ ] Write the client's main goal in one sentence they would agree with
- [ ] List every deliverable and what each one includes
- [ ] Write down what is not included, in plain words
- [ ] Note how many rounds of changes each deliverable includes

## Before you price

- [ ] Estimate the hours for each deliverable separately
- [ ] Add time for meetings, emails and project management
- [ ] Check whether any outside costs need to be passed on
- [ ] Decide which dates are fixed and which can move

## Before you send

- [ ] Check the client's name, project name and dates are correct
- [ ] Make sure the total matches the lines in the quote worksheet
- [ ] State how long the proposal is valid for
- [ ] Explain the next step if the client wants to go ahead
` },
      { name: "follow-up-plan.md", template: false, description: "When and how to follow up an open proposal", text: `# Proposal follow-up plan

## Day 0: send

- Send the proposal with a short note offering a call to go through it
- Add it to proposal-log.csv with the date sent and the valid-until date

## Day 3: first follow-up

- Ask whether the client has had a chance to read it
- Offer a 15-minute call to answer questions

## Day 7: second follow-up

- Mention the valid-until date and ask if anything needs changing
- Offer a smaller first phase if the scope seems too large

## Valid-until date: close the loop

- Ask whether to keep the proposal open, change it or close it
- Record the outcome in the log: accepted, declined or no reply
- Note the reason when a proposal is declined, to improve the next one
` },
      { name: "quote-worksheet.csv", template: true, description: "Quote worksheet: one line per piece of work, hours and price", text: csv([["Proposal", "Line", "Description", "Hours", "Rate", "Line price", "Notes"], ["Example proposal", "1", "Discovery workshop and written summary", "6", "50", "300", "Delete this example row"], ["Example proposal", "2", "Two rounds of design changes", "8", "50", "400", "Delete this example row"]]) },
      { name: "proposal-log.csv", template: true, description: "One row per proposal: sent, follow-ups and outcome", text: csv([["Client", "Project", "Sent on", "Valid until", "Total", "Follow-up 1", "Follow-up 2", "Outcome", "Reason", "Notes"], ["Example Ltd", "Website refresh", "2026-01-05", "2026-01-26", "700", "2026-01-08", "2026-01-12", "Accepted", "", "Delete this example row"]]) },
    ],
  }),
  concept({
    id: "project-tracking-kit", name: "Project tracking kit", audience: "freelancers and small teams",
    problem: "keeping client projects, deadlines and change requests visible in one place",
    offer: "A project tracker, task list, change-request log, weekly status update template and a weekly review routine.",
    hook: "Which client project is due next, and what did you agree to change? Keep it all in one place.",
    pitch: {
      headline: "See every client project, deadline and change in one place",
      subheadline: "For freelancers and small teams: a project tracker, task list, change log and a weekly status routine.",
      benefits: ["Track every project's stage and next deadline in one sheet", "Log each change request with its decision", "Send a short, consistent status update every week", "Review all projects in a 20-minute weekly routine"],
      faq: [{ q: "What format is it in?", a: "CSV trackers for any spreadsheet program and Markdown templates for any text editor." }],
    },
    ratings: { usefulness: 0.7, simplicity: 0.85, monetisation: 0.6 },
    reasons: { usefulness: "useful but many free project tools exist", simplicity: "Markdown and CSV only", monetisation: "general audience; less tied to the existing buyers" },
    price: 7, priceRationale: "GBP 7: a smaller pack with strong free alternatives; a hypothesis to test, not based on market price data.",
    setup: ["Open `project-tracker.csv` and add one row per active project.", "List the next tasks for each project in `task-list.csv`.", "Log every change request in `change-log.csv` before doing the work.", "Every week, follow `weekly-review.md` and send updates with `status-update-template.md`."],
    files: [
      { name: "project-tracker.csv", template: true, description: "One row per project: stage, next deadline and owner", text: csv([["Project", "Client", "Stage", "Next deadline", "Next deliverable", "Owner", "Last update sent", "Notes"], ["Website refresh", "Example Ltd", "Design", "2026-02-02", "Homepage design", "You", "2026-01-26", "Delete this example row"]]) },
      { name: "task-list.csv", template: true, description: "Tasks per project with due dates and status", text: csv([["Project", "Task", "Due", "Status", "Notes"], ["Website refresh", "Prepare two homepage layouts", "2026-01-30", "Doing", "Delete this example row"]]) },
      { name: "change-log.csv", template: true, description: "Change requests with date, impact and decision", text: csv([["Project", "Requested on", "Requested by", "Change", "Impact on time", "Decision", "Decided on", "Notes"], ["Website refresh", "2026-01-20", "Client", "Add a contact page", "2 days", "Agreed in writing", "2026-01-21", "Delete this example row"]]) },
      { name: "status-update-template.md", template: true, description: "A short weekly status update to send each client", text: `# Weekly update: [[Project name]], week of [[date]]

## Done this week

- [[What was completed, in one line each]]

## Next week

- [[What you will work on next]]

## Needed from you

- [[Decisions, feedback or files you need, with the date you need them]]

## Dates

- Next deliverable: [[deliverable and date]]
- Changes agreed this week: [[none, or the change and its effect on dates]]
` },
      { name: "weekly-review.md", template: false, description: "A 20-minute weekly review routine for all projects", text: `# Weekly review (20 minutes)

## 1. Projects (5 minutes)

- Update the stage and next deadline of every row in the project tracker
- Mark any project whose next deadline is within seven days

## 2. Tasks (5 minutes)

- Move finished tasks to Done and add the next ones
- Give every open task a due date and a status

## 3. Changes (5 minutes)

- Check that every new request is in the change log
- Confirm in writing any change that affects dates before starting it

## 4. Updates (5 minutes)

- Send each client a status update using the template
- Record the date sent in the project tracker
- Note anything you are waiting for from a client
` },
    ],
  }),
];

/** Concepts registered at run time: AI-made concepts loaded from the store (ai-concepts.json), and test concepts. */
export const EXTRA_CONCEPTS: Concept[] = [];
/** Makes the store's AI-made concepts available to the blueprint (so builds, reviews and repairs regenerate the same files). */
export function loadStoredConcepts(stored: readonly Concept[]): void {
  for (const c of stored) if (!CONCEPTS.some((x) => x.id === c.id) && !EXTRA_CONCEPTS.some((x) => x.id === c.id)) EXTRA_CONCEPTS.push(c);
}
export const conceptFor = (o: Pick<Opportunity, "source">): Concept | undefined => [...CONCEPTS, ...EXTRA_CONCEPTS].find((c) => o.source === `factory:${c.id}`);

export const toolkit: Blueprint = {
  id: "toolkit",
  defaultPrice: 9,
  matches: (o) => !!conceptFor(o),
  productName: (i) => conceptFor(i.opportunity)!.name,
  pitch: (i) => conceptFor(i.opportunity)!.pitch,
  files: (i) => conceptFor(i.opportunity)!.files.map((f) => ({ ...f })),
};
