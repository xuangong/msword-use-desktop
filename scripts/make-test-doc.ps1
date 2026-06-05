$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot '..\test-fixtures'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$out = (Resolve-Path $dir).Path + '\sample.docx'
if (Test-Path $out) { Remove-Item $out }

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Add()
$sel = $word.Selection

function H1($t) { $sel.Style = $doc.Styles.Item('Heading 1'); $sel.TypeText($t); $sel.TypeParagraph() }
function H2($t) { $sel.Style = $doc.Styles.Item('Heading 2'); $sel.TypeText($t); $sel.TypeParagraph() }
function P($t)  { $sel.Style = $doc.Styles.Item('Normal');    $sel.TypeText($t); $sel.TypeParagraph() }

H1 'Quarterly Product Review - Draft'

P 'Author: Test Fixture    Date: 2026-Q2'

H2 '1. Executive Summary'
P 'This document is a draft and contains a few issues on purpose so that the agent has somthing real to fix. The goal is to validate end-to-end behaviour: outline extraction, paragraph polishing, find-and-replace, and structured edits.'
P 'Overall, the prodcut shipped on time, however adoption has been slower then expected, and the team is working hard to improve onboarding flow which is currently a bit confusing for new users who do not have prior experience with similar tools.'

H2 '2. Highlights'
$sel.Style = $doc.Styles.Item('List Bullet')
$sel.TypeText('Daily active users grew 14% quarter over quarter.'); $sel.TypeParagraph()
$sel.TypeText('Latency p95 dropped from 820ms to 410ms after the caching rework.'); $sel.TypeParagraph()
$sel.TypeText('We hired two new engineers; both ramped up in under three weeks.'); $sel.TypeParagraph()
$sel.TypeText('Customer NPS rose from 31 to 42 - the highest since launch.'); $sel.TypeParagraph()

H2 '3. Risks'
P 'There are a couple of items we are tracking as risks for next quarter, including: (a) the depencency on the third-party API which has had two outages in the last 30 days, and (b) staffing gaps in the platform team which mean that on-call rotation is currently very tight, this needs to be addressed before the holiday code freeze.'

H2 '4. Action Items'
$sel.Style = $doc.Styles.Item('List Number')
$sel.TypeText('Replace the ACME billing API with our in-house equivalent - owner: Priya, due 2026-07-15.'); $sel.TypeParagraph()
$sel.TypeText('Hire one additional SRE - owner: Jordan, due 2026-08-01.'); $sel.TypeParagraph()
$sel.TypeText('Run a customer interview round focused on onboarding pain - owner: Sam, due 2026-06-30.'); $sel.TypeParagraph()

H2 '5. Appendix'
P 'TODO: insert chart of weekly active users.'
P 'TODO: link to the post-mortem doc for the May 12 outage.'
P 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. This paragraph is intentionally long and a little rambly so that the polish_text tool has obvious material to tighten; it includes redundent words, run-on clauses, and the kind of filler phrasing that real drafts tend to contain when authors are typing fast and have not yet had a chance to revise their work for clarity, concision, or flow.'

# wdFormatDocumentDefault = 16 (.docx)
$doc.SaveAs([ref]$out, [ref]16)
$doc.Close()
$word.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null

Write-Host "Wrote $out"
