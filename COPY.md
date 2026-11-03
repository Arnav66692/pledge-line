# Site copy, before and after

Every string a person can read or hear from a screen reader on the donor page and the staff view, on `feat/human-copy` from `pilot` at f157c55. "kept" means the words did not change. Line numbers are in the new files.

What the line speaks lives in `src/say.js` and `src/vocabulary.js`. The pilot grader hashes those, so they are not here and did not change. The same goes for the script titles and the words after "What should happen", which come from `src/pilot-scripts.js`, and the error messages the server sends, which come from `src/server.js`.

## The headline

Kept: "Every word backed by PayPal". It is short, true for every sentence that states a fact, and the receipts show it.

A plainer option I considered, not used: "It only says what PayPal shows". It is more literal but weaker, and the old line still holds, so the old line stays.

## Pages (HTML)

| where | old | new | why |
| --- | --- | --- | --- |
| web/index.html:6 | Pledge Line | kept | Kept, already plain. |
| web/index.html:7 (meta description) | The after-hours donor line for small nonprofits. A PayPal sandbox demo with no real money. | An after-hours line where monthly donors to a small nonprofit can check, pause or restart their gift. A demo on PayPal's test system, no real money. | Says what a donor can do there, and "test system" is plainer than "sandbox" for a donor. |
| web/index.html:20 | Skip to the call | kept | Kept, already plain. |
| web/index.html:24 (aria-label) | Pledge Line, back to the start | Pledge Line, back to the top | The logo scrolls to the top of the page, so say that. |
| web/index.html:24 | pledge | kept | Kept, already plain. |
| web/index.html:24 | line | kept | Kept, already plain. |
| web/index.html:25 (aria-label) | Primary | kept | Kept, already plain. |
| web/index.html:26 | The line | kept | Kept, already plain. |
| web/index.html:27 | Receipts | kept | Kept, already plain. |
| web/index.html:28 | Staff | kept | Kept, already plain. |
| web/index.html:34 | Menu | kept | Kept, already plain. |
| web/index.html:38 (aria-label) | Menu | kept | Kept, already plain. |
| web/index.html:41 (aria-label) | Menu | kept | Kept, already plain. |
| web/index.html:43 | 01 | kept | Kept. |
| web/index.html:43 | The line | kept | Kept, already plain. |
| web/index.html:44 | 02 | kept | Kept. |
| web/index.html:44 | Receipts | kept | Kept, already plain. |
| web/index.html:45 | 03 | kept | Kept. |
| web/index.html:45 | Staff | kept | Kept, already plain. |
| web/index.html:49 | The after-hours donor line | kept | Kept, already plain. |
| web/index.html:49 | PayPal sandbox. No real money moves. | A demo on PayPal's test system. No real money moves. | Same fact in plain words. "Sandbox" stays in the footer and chips for judges. |
| web/index.html:51 | MIT license | kept | Kept, already plain. |
| web/index.html:52 | Sandbox only | kept | Kept, already plain. |
| web/index.html:62 | Pledge Line. | kept | Kept, already plain. |
| web/index.html:63 | the after-hours donor line for small nonprofits | kept | Kept, already plain. |
| web/index.html:64 | Every word | kept | Kept, already plain. |
| web/index.html:65 | backed by PayPal | kept | Kept, already plain. |
| web/index.html:70 | Start a call | kept | Kept, already plain. |
| web/index.html:70 | Start a call | kept | Kept, already plain. |
| web/index.html:75 | PayPal sandbox demo. No real money moves, and no real donor is called. | This is a demo on PayPal's test system. No real money moves, and the donor is a test account. | Donors call the line, so "no real donor is called" read backwards. The donor is a sandbox test account, which is the true fact. |
| web/index.html:78 (aria-label) | The call | kept | Kept, already plain. |
| web/index.html:81 | Your call | kept | Kept, already plain. |
| web/index.html:82 | Mute the line's voice | Mute the voice | Shorter. There is only one voice. |
| web/index.html:84 | No call yet. Press Start call. | Press Start call when you're ready. | Drops the empty "No call yet" and says the next step warmly. |
| web/index.html:85 | Start call | kept | Kept, already plain. |
| web/index.html:88 | The line says | kept | Kept, already plain. |
| web/index.html:92 | You said | kept | Kept, already plain. |
| web/index.html:97 | Hold to talk | kept | Kept, already plain. |
| web/index.html:98 | Hold the button, or the Space bar, while you speak. Let go when you finish. | Hold this button or the Space bar while you talk, and let go when you're done. | One sentence, everyday words. |
| web/index.html:103 | PIN keypad | kept | Kept, already plain. |
| web/index.html:104 | No digits yet | No numbers yet | "Numbers" is the word an older donor uses. |
| web/index.html:106 | 1 | kept | Kept. |
| web/index.html:107 | 2 | kept | Kept. |
| web/index.html:108 | 3 | kept | Kept. |
| web/index.html:109 | 4 | kept | Kept. |
| web/index.html:110 | 5 | kept | Kept. |
| web/index.html:111 | 6 | kept | Kept. |
| web/index.html:112 | 7 | kept | Kept. |
| web/index.html:113 | 8 | kept | Kept. |
| web/index.html:114 | 9 | kept | Kept. |
| web/index.html:115 (aria-label) | Clear the PIN | kept | Kept, already plain. |
| web/index.html:115 | Clear | kept | Kept, already plain. |
| web/index.html:116 | 0 | kept | Kept. |
| web/index.html:117 (aria-label) | Send the PIN | kept | Kept, already plain. |
| web/index.html:117 | Send | kept | Kept, already plain. |
| web/index.html:122 | Type instead | kept | Kept, already plain. |
| web/index.html:124 | What you want to say | kept | Kept, already plain. |
| web/index.html:127 | Send | kept | Kept, already plain. |
| web/index.html:133 | Demo controls | kept | Kept, already plain. |
| web/index.html:135 | Script | kept | Kept, already plain. |
| web/index.html:137 | Free call | No script | "Free call" sounds like it costs nothing. "No script" says what the option is. |
| web/index.html:139 | Pick a script before you start, so the record knows which one you ran. Say each line after the line stops talking. | Pick a script before you start so the call is filed under it. Wait for the line to finish talking before you say each line. | The record does not "know" things. Says what happens and what to do. |
| web/index.html:140 (aria-label) | Lines to say | kept | Kept, already plain. |
| web/index.html:141 | Last gap | Wait for a reply, last turn | "Gap" is grader jargon. Says what is timed. |
| web/index.html:141 | none yet | kept | Kept, already plain. |
| web/index.html:141 | . Median of voice turns | . Median of spoken turns | "Spoken" is plainer than "voice turns". |
| web/index.html:141 | none yet | kept | Kept, already plain. |
| web/index.html:141 | . | kept | Kept. |
| web/index.html:147 | Every sentence, with its PayPal read | Every sentence, checked against PayPal | "PayPal read" as a noun is our jargon. |
| web/index.html:148 | What the line said | kept | Kept, already plain. |
| web/index.html:149 | Each sentence with a fact in it shows the PayPal read behind it. Times are Pacific. | When a sentence has an amount, a date or a change in it, you can see what PayPal said and when. Times are Pacific. | Names the facts (amount, date, change) instead of the abstract "fact", and drops "read" as a noun. |
| web/index.html:150 | Nothing said yet. | kept | Kept, already plain. |
| web/index.html:151 (aria-label) | Everything the line said, with receipts | Everything the line said, with the proof for each sentence | Screen readers get what a receipt is, not the metaphor. |
| web/index.html:157 | PayPal's record | kept | Kept, already plain. |
| web/index.html:159 | Waiting for your yes | kept | Kept, already plain. |
| web/index.html:165 | Monthly gift | kept | Kept, already plain. |
| web/index.html:166 | not read yet | kept | Kept, already plain. |
| web/index.html:167 | Not read from PayPal yet. | kept | Kept, already plain. |
| web/index.html:170 | Amount | kept | Kept, already plain. |
| web/index.html:170 | not read yet | kept | Kept, already plain. |
| web/index.html:171 | Next date | Next payment | Next date of what. It is the next payment. |
| web/index.html:171 | not read yet | kept | Kept, already plain. |
| web/index.html:172 | Debug id | kept | Kept, already plain. |
| web/index.html:172 | none | kept | Kept, already plain. |
| web/index.html:177 | One-time gift invoice | kept | Kept, already plain. |
| web/index.html:179 | Invoice number | kept | Kept, already plain. |
| web/index.html:179 | none | kept | Kept, already plain. |
| web/index.html:180 | Status | kept | Kept, already plain. |
| web/index.html:180 | none | kept | Kept, already plain. |
| web/index.html:181 | Amount | kept | Kept, already plain. |
| web/index.html:181 | none | kept | Kept, already plain. |
| web/index.html:182 | Debug id | kept | Kept, already plain. |
| web/index.html:182 | none | kept | Kept, already plain. |
| web/index.html:183 | Payer page | Payment page | "Payer" is PayPal jargon. |
| web/index.html:183 | none | kept | Kept, already plain. |
| web/index.html:188 | Event log | kept | Kept, already plain. |
| web/index.html:189 | Newest first. Every PayPal read and change shows here. | Newest first. Every time the line read or changed something in PayPal, it shows here. | Drops "read" as a noun. |
| web/index.html:190 (aria-label) | Event log, newest first | kept | Kept, already plain. |
| web/index.html:195 | Pledge Line pilot, MIT license. PayPal sandbox only. | kept | Kept, already plain. |
| web/index.html:196 | ©2026 | kept | Kept. |
| web/index.html:202 (title) | Background sound | kept | Kept, already plain. |
| web/index.html:205 | Background sound | kept | Kept, already plain. |
| web/index.html:209 | PayPal | kept | Kept, already plain. |
| web/index.html:211 | record | kept | Kept, already plain. |
| web/index.html:212 | PayPal's record | kept | Kept, already plain. |
| web/index.html:214 | ©2026 | kept | Kept. |
| web/staff.html:6 | Pledge Line staff view | Pledge Line, staff | Shorter tab title. |
| web/staff.html:7 (meta description) | The morning after. Every call the line took, what PayPal changed, and the PayPal read behind every sentence the line said. | For the nonprofit's staff the next morning. Every call the line took, what changed in PayPal, and the proof for what it said. | Says who it is for and drops the stacked "PayPal read behind every sentence". |
| web/staff.html:21 | Skip to the record | Skip to the calls | The section is the calls. |
| web/staff.html:25 (aria-label) | Pledge Line, the donor line | kept | Kept, already plain. |
| web/staff.html:25 | pledge | kept | Kept, already plain. |
| web/staff.html:25 | line | kept | Kept, already plain. |
| web/staff.html:26 (aria-label) | Primary | kept | Kept, already plain. |
| web/staff.html:27 | The line | kept | Kept, already plain. |
| web/staff.html:28 | Receipts | kept | Kept, already plain. |
| web/staff.html:29 | Staff | kept | Kept, already plain. |
| web/staff.html:35 | Menu | kept | Kept, already plain. |
| web/staff.html:39 (aria-label) | Menu | kept | Kept, already plain. |
| web/staff.html:42 (aria-label) | Menu | kept | Kept, already plain. |
| web/staff.html:44 | 01 | kept | Kept. |
| web/staff.html:44 | The line | kept | Kept, already plain. |
| web/staff.html:45 | 02 | kept | Kept. |
| web/staff.html:45 | Receipts | kept | Kept, already plain. |
| web/staff.html:46 | 03 | kept | Kept. |
| web/staff.html:46 | Staff | kept | Kept, already plain. |
| web/staff.html:50 | The after-hours donor line | kept | Kept, already plain. |
| web/staff.html:50 | PayPal sandbox. No real money moves. | A demo on PayPal's test system. No real money moves. | Same fact in plain words. "Sandbox" stays in the footer and chips for judges. |
| web/staff.html:52 | MIT license | kept | Kept, already plain. |
| web/staff.html:53 | Sandbox only | kept | Kept, already plain. |
| web/staff.html:61 | Staff view, Pledge Line | kept | Kept, already plain. |
| web/staff.html:62 | the morning | kept | Kept, already plain. |
| web/staff.html:62 | after | kept | Kept, already plain. |
| web/staff.html:63 | Every call the line took, what PayPal changed, and the PayPal read behind every sentence the line said. | Every call the line took, what changed in PayPal, and the proof for what it said. | Same three things, fewer stacked nouns. Shortened again after it left "from." alone on a line at 390 px. |
| web/staff.html:64 | This is a PayPal sandbox demo. No real money moves. Only staff with the key can read this record. | This is a demo on PayPal's test system. No real money moves. You need the staff key to see the calls. | Plain words, and "you need the key" instead of a rule about who may read. |
| web/staff.html:68 | Staff key | kept | Kept, already plain. |
| web/staff.html:69 | Type the staff key set as STAFF_KEY for this line. This tab keeps it until you close it, and nothing else stores it. | Enter the staff key, the STAFF_KEY value set for this line. This tab remembers it until you close it, and it isn't saved anywhere else. | Same storage promise, said the way a person would. |
| web/staff.html:71 | Staff key | kept | Kept, already plain. |
| web/staff.html:74 | Open the record | Show the calls | Says what the button shows. |
| web/staff.html:81 (aria-label) | Totals for the calls shown | kept | Kept, already plain. |
| web/staff.html:82 | 0 | kept | Kept. |
| web/staff.html:82 | calls | kept | Kept, already plain. |
| web/staff.html:83 | 0 | kept | Kept. |
| web/staff.html:83 | sentences proven | kept | Kept, already plain. |
| web/staff.html:84 | 0 | kept | Kept. |
| web/staff.html:84 | plain sentences | kept | Kept, already plain. |
| web/staff.html:85 | 0 | kept | Kept. |
| web/staff.html:85 | sentences blocked | kept | Kept, already plain. |
| web/staff.html:86 | 0 | kept | Kept. |
| web/staff.html:86 | PayPal changes | changes in PayPal | Reads as a phrase under a number. |
| web/staff.html:87 | 0 | kept | Kept. |
| web/staff.html:87 | callbacks asked | asked for a call back | "Callbacks asked" is clipped. Matches the donor page wording "call back". |
| web/staff.html:91 | Calls | kept | Kept, already plain. |
| web/staff.html:92 | Loading the record. | Loading the calls. | The board loads calls. |
| web/staff.html:97 | Filter calls | Search the calls | "Search" is the everyday word for this box. |
| web/staff.html:98 (placeholder) | Pause, blocked, Script 2, callback | Try pause, blocked or Script 2 | Reads as a hint instead of a list of tags. |
| web/staff.html:101 | Refresh | kept | Kept, already plain. |
| web/staff.html:102 | Forget the key | kept | Kept, already plain. |
| web/staff.html:106 | Pick a call to read every sentence and its receipt. With the keyboard, move to a row with the arrow keys and press Enter. | Pick a call to see everything the line said and the proof for each sentence. With a keyboard, use the arrow keys and press Enter. | Says what you will see, and cuts the keyboard hint to what a person needs. |
| web/staff.html:109 (aria-label) | Calls, one row per call | kept | Kept, already plain. |
| web/staff.html:113 | Call | kept | Kept, already plain. |
| web/staff.html:114 (aria-label) | Close the call details | kept | Kept, already plain. |
| web/staff.html:114 | Close | kept | Kept, already plain. |
| web/staff.html:123 | Pledge Line pilot, MIT license. PayPal sandbox only. Grid by AG Grid Community, | kept | Kept, already plain. |
| web/staff.html:123 | MIT license | kept | Kept, already plain. |
| web/staff.html:123 | . | kept | Kept. |
| web/staff.html:124 | ©2026 | kept | Kept. |

## Scripts (string literals shown to people)

| where | old | new | why |
| --- | --- | --- | --- |
| web/app.js:28 | Active, Suspended, Cancelled, Expired, Waiting for approval (status words) | kept | Kept, already plain. |
| web/app.js:36 | pin_ok chip `PIN passed` | `PIN accepted` | Same words the status line and event log use. |
| web/app.js:36 | pin_bad chip, fell back to `Checked, a wrong PIN in that turn` | `That PIN didn't match` | Every claim now has a plain label. The grader meaning moves to the title. |
| web/app.js:36 | tries_left chip, fell back to `Checked, a wrong PIN in that turn that left that many tries` | `Tries left, counted on this call` | Plain label, full meaning in the title. |
| web/app.js:36 | pin_locked chip, fell back to `Checked, a lock in that turn` | `Call locked after wrong PINs` | Plain label, full meaning in the title. |
| web/app.js:37 | pin_limit chip, fell back to `Checked, a pin_limit refusal in that turn` | `Too many wrong PINs from here` | Removes a code name from the page. Meaning in the title. |
| web/app.js:37 | not_verified chip `No PIN yet` | kept | Kept, already plain. |
| web/app.js:38 | wrote chip `PayPal accepted the change` | `PayPal confirmed the change` | "Confirmed" is what a donor expects to hear. Backed by an ok write, as before. |
| web/app.js:38 | wrote_suspend chip `PayPal accepted the pause` | `PayPal confirmed the pause` | Same. |
| web/app.js:38 | wrote_activate chip `PayPal accepted the restart` | `PayPal confirmed the restart` | Same. |
| web/app.js:39 | wrote_cancel chip `PayPal accepted the cancel` | `PayPal confirmed the cancel` | Same. |
| web/app.js:39 | wrote_send_invoice chip `PayPal accepted the send` | `PayPal confirmed it sent` | "The send" is not how people talk. |
| web/app.js:40 | write_failed chip, fell back to `Checked, a subscription write PayPal refused in that turn, with a 4xx or a read after it that does not show the change` | `PayPal turned down the change` | The worst of the grader text on the page. Full meaning stays in the title. |
| web/app.js:40 | send_failed chip, fell back to `Checked, a send PayPal refused in that turn, with a 4xx ...` | `PayPal turned down the send` | Same. |
| web/app.js:40 | write_unclear chip, fell back to `Checked, a write in that turn that PayPal gave no clear answer to, and a read of its target after it` | `PayPal gave no clear answer` | Same. |
| web/app.js:41 | gift_unread chip, fell back to `Checked, a subscription write in that turn whose latest read after it found nothing` | `PayPal found no gift after the change` | Same. |
| web/app.js:41 | invoice_unread chip, fell back to `Checked, a send in that turn whose latest read after it found nothing` | `PayPal found no invoice after the send` | Same. |
| web/app.js:42 | draft_deleted chip, fell back to `Checked, a delete of this call's own draft in that turn, a read after it that PayPal answered with 404, and no send of it` | `Draft deleted, PayPal no longer finds it` | Same. "No longer finds it" is the 404 in plain words. |
| web/app.js:42 | draft_kept chip, fell back to `Checked, a delete of this call's own draft in that turn, and a read after it that still finds the draft` | `The draft is still in PayPal` | Same. |
| web/app.js:43 | no_gift chip, fell back to `Checked, a read of the call's own subscription in that turn that found nothing` | `PayPal found no monthly gift` | Same. |
| web/app.js:43 | no_email chip, fell back to `Checked, a read of the call's own subscription in that turn with no email on file` | `PayPal has no email on file` | Same. |
| web/app.js:43 | paypal_unclear chip, fell back to `Checked, a PayPal step in that turn that failed, found nothing, or made a draft it deleted, and no ok write` | `A PayPal step didn't go through` | Same. |
| web/app.js:44 | unchanged chip `Nothing changed in PayPal` | kept | Kept, already plain. |
| web/app.js:44 | no_pause chip, fell back to `Checked, a no to a pause in that turn, and no ok write` | `You said no, nothing changed` | The example Arnav flagged. Meaning in the title. |
| web/app.js:44 | email_refused chip, fell back to `Checked, an other_email refusal in that turn` | `New email turned down` | Removes a code name. Meaning in the title. |
| web/app.js:45 | set_aside chip `Request set aside, nothing changed` | `Set aside, nothing changed` | Shorter. |
| web/app.js:45 | callback_noted chip, fell back to `Checked, a staff callback logged in that turn` | `Call back noted for staff` | Plain label. |
| web/app.js:45 | turn_limit chip, fell back to `Checked, a turn_limit refusal in that turn` | `The call reached its limit` | Removes a code name. |
| web/app.js:46 | timed_out chip, fell back to `Checked, a proposal that timed out since the line last said so, and no ok write in that turn` | `Timed out, nothing changed` | Plain label. |
| web/app.js:46 | nothing_pending chip, fell back to `Checked, no proposal still open` | `Nothing waiting for a yes` | Plain label. |
| web/app.js:46 | call_ended chip, fell back to `Checked, a call_end before it` | `The call had ended` | Removes a code name. |
| web/app.js:47 | gift_read chip `PayPal read of your gift` | `Read your gift from PayPal` | A verb instead of "read" as a noun. |
| web/app.js:47 | gift_active chip, fell back to `Checked, a read of the call's own subscription that shows it active` | `PayPal shows the gift active` | Plain label. |
| web/app.js:47 | nothing_to chip, fell back to `Checked, a read of the call's own subscription whose status that change can't act on` | `PayPal shows nothing to change` | The example in the brief. Full meaning in the title. |
| web/app.js:48 | invoice_read chip `PayPal read of the draft` | `Read the draft from PayPal` | A verb instead of "read" as a noun. |
| web/app.js:48 | gift_rechecked chip `Fresh PayPal read in this reply` | `Read PayPal again for this answer` | Plain. I tried "just now" first and dropped it, since the chip stays on screen after the moment passes. |
| web/app.js:51 | pausing / restarting / cancelling the monthly gift, sending the one-time gift invoice | kept | Kept, already plain. Used in the event log. |
| web/app.js:53-55 | refusal reasons, such as `the PIN comes first`, `the line only sends to the email on file` | kept | Kept, already plain. |
| web/app.js:58 | The browser blocked the microphone. Allow it in the site settings, or type instead. | kept | Kept, already plain. |
| web/app.js:60 | Speech input in Safari needs Siri. Turn on Siri in System Settings, then reload, or type instead. | kept | Kept, it names the real fix. |
| web/app.js:61 | Speech input is turned off in this browser. Please type instead. | kept | Kept. |
| web/app.js:62 | I didn't hear anything. Hold the button while you speak, or type instead. | kept | Kept, already warm. |
| web/app.js:63 | Speech input needs a network connection. Try again, or type instead. | Talking needs an internet connection. Try again, or type instead. | "Internet" is the everyday word. |
| web/app.js:64 | No microphone was found. Please type instead. | kept | Kept. |
| web/app.js:78 | The line could not answer. Please try again. | The line didn't answer. Please try again. | Contraction, like a person says it. |
| web/app.js:102 | Enter your PIN on the keypad, then ask about your monthly gift. | kept | Kept, already plain. |
| web/app.js:111 | `Expected. ${expected}.` | `What should happen. ${expected}.` | "Expected." alone reads like a test log. |
| web/app.js:123 | `Script ${n}, ${title}` | kept | Kept. |
| web/app.js:178 | `Read from PayPal at ${time}, status ${rawStatus}.` | kept | Kept. The raw PayPal status is the proof. |
| web/app.js:195 | `Changed during this call, ${from} to ${to}.` | `Changed on this call, from ${from} to ${to}.` | Adds "from" so it reads as a sentence. |
| web/app.js:205 | Not read from PayPal yet. | kept | Kept. |
| web/app.js:217-225 | Not found, not read yet, none, not found, deleted (gift and invoice card values) | kept | Kept, short and true. |
| web/app.js:232 | Open the PayPal payer page | Open PayPal's payment page | "Payer page" is PayPal jargon. |
| web/app.js:242 | `${label}. Nothing changes in PayPal until you say yes.` | kept | Kept, it is the key promise and already plain. |
| web/app.js:244 | `This request times out at ${time}.` / `This request times out soon.` | `It waits for your answer until ${time}.` / `It waits a little while for your answer.` | "Times out" is software talk. |
| web/app.js:266-267 | read chip key `read ${time}`, fallback `in this call` | `at ${time}`, fallback `some point in this call` | Feeds the chip below. Only the words changed, the grouping key is still one per read time. |
| web/app.js:274 | `The line's own limit, ${values}` | kept | Kept, honest that it is not a PayPal read. |
| web/app.js:276 | chip title `PayPal ${what} ${id}, debug id ${debugId}` | `Read of PayPal ${what} ${id}, debug id ${debugId}` | The hover says what the id is. |
| web/app.js:277 | chip `PayPal, read 5:42:07 pm, $25.00, suspended` | `From PayPal at 5:42:07 pm, $25.00, suspended` | Reads as words instead of a log line. |
| web/app.js:281 | claim chip title `Checked, ${meaning}` and the no-label fallback text `Checked, ${meaning}` | `Backed by ${meaning}` | The robotic "Checked, a ..." opener is gone. Every claim has a label now, so the fallback should never show. |
| web/app.js:300 | Not backed by PayPal | Not backed by the record | A blocked sentence can fail on the call record, such as a PIN claim, not only on PayPal. Matches the summary line. |
| web/app.js:314 | Greeting, `Reply ${n}` | kept | Kept. |
| web/app.js:326 | Nothing said yet. | kept | Kept. |
| web/app.js:327 | `N sentences said. P proven against this call's record, Q with nothing to prove, R not backed.` | `N sentences so far. P backed by the record, Q with nothing to check, R not backed.` | Less legal sounding, and "backed" matches the chips. |
| web/app.js:337 | Call started. | kept | Kept. |
| web/app.js:338 | `Heard by ${source}, "${text}".` (as in Heard by typed) | `Heard "${text}", ${source}.` | "Heard by typed" was broken English. |
| web/app.js:339-340 | PIN accepted. / Wrong PIN. | kept | Kept. |
| web/app.js:341 | Too many wrong PINs, so the call is locked. | Too many wrong PINs. The call is locked. | Two short sentences. |
| web/app.js:342 | `Understood as ${intent}.` | kept | Kept. |
| web/app.js:344 | `Read the ${what} from PayPal, which says it is not found.` | `Asked PayPal for the ${what}. PayPal couldn't find it.` | Plain order of events. |
| web/app.js:345 | `Could not read the ${what} from PayPal, ${error}.` | `Couldn't read the ${what} from PayPal, ${error}.` | Contraction. |
| web/app.js:346 | `Read the ${what} from PayPal, status X, debug id Y.` | kept | Kept, it is the proof. |
| web/app.js:347 | `Asked for a yes before ${what}.` | kept | Kept. |
| web/app.js:348 | Heard a clear yes in its own turn, so a one-time write token was issued. | Heard a clear yes on its own, so the line may make this one change. | "One-time write token" is code talk. Same meaning, one change allowed. |
| web/app.js:349 | Heard a no. | kept | Kept. |
| web/app.js:350 | `PayPal accepted ${what}, debug id X.` / `PayPal did not accept ${what}, ${error}.` | `PayPal said yes to ${what}, debug id X.` / `PayPal turned down ${what}, ${error}.` | "Accepted pausing the monthly gift" was stiff. |
| web/app.js:352 | `Created a private draft invoice, ${id}.` / Could not create a draft invoice. | `Made a draft invoice, ${id}. It isn't sent.` / Couldn't make a draft invoice. | "Private" was vague. Says the fact, it is not sent. |
| web/app.js:353 | `Could not delete the draft invoice ${id}.` | `Couldn't delete the draft invoice ${id}.` | Contraction. |
| web/app.js:354 | `Refused, ${reason}.` | `Turned down, ${reason}.` | Softer, same meaning. |
| web/app.js:355 | The pending request timed out, nothing changed. | No answer in time, so nothing changed. | No "pending request" jargon. |
| web/app.js:356 | The pending request was dropped. | The request was set aside. | Matches the chip and what the line says. |
| web/app.js:357 | Noted a request for a staff callback. | Noted that you want a call back from staff. | Speaks to the donor. |
| web/app.js:358 | `Call ended, ${reason}.` | kept | Kept. |
| web/app.js:398 | End call / Start call | kept | Kept. chrome.js also reads "End call" to know a call is live. |
| web/app.js:405 | This call is locked after too many wrong PINs. | kept | Kept. |
| web/app.js:406, 488 | Call ended. Press Start call for a new one. | kept | Kept. |
| web/app.js:407 | Enter your PIN on the keypad, or say its digits. | Enter your PIN on the keypad, or say the numbers. | "Numbers" over "digits". |
| web/app.js:408 | `Verified. Running script ${n}.` / Verified. Ask about your monthly gift. | `PIN accepted. Running script ${n}.` / PIN accepted. Go ahead and ask about your monthly gift. | "Verified." alone is cold. Says what happened, then invites the question. |
| web/app.js:441 | `${s}, muted` / `${s}, the reply never started` | `${s}, muted` / `${s}, the reply didn't play` | Plainer. |
| web/app.js:444 | `${s} over ${n} turns` | kept | Kept. |
| web/app.js:598 | No digits yet | No numbers yet | Matches the HTML. |
| web/app.js:669 | Hold to talk is not available here | Talking isn't available in this browser | Says where. |
| web/app.js:670 | This browser has no speech input, so use the typed box below. | This browser can't listen, so please type below. | No "speech input" or "typed box". |
| web/chrome.js:418 | `Background sound, on` / `Background sound, off` (title) | kept | Kept, already plain. |
| web/staff.js:21 | hear the gift | check the gift | What the donor wanted, in their words. |
| web/staff.js:21-23 | stop the gift, cancel now, pause the gift, restart the gift, one-time gift, how do you know, repeat, help, a call back, goodbye, unclear | kept | Kept. |
| web/staff.js:22 | a new email, refused | a new email, turned down | Same word as the donor page. |
| web/staff.js:26-31 | paused the gift ... refused the delete (what PayPal changed) | kept | Kept, short and clear in the grid. |
| web/staff.js:34 | Proven, Plain, Blocked (badges) | kept | Kept as the staff page's three terms. The grid's search and sort use them, and the hint below explains them. |
| web/staff.js:35 | closed by the page | page closed | Shorter. |
| web/staff.js:35 | said goodbye, locked after wrong PINs, went idle | kept | Kept. |
| web/staff.js:55-60 | not yet, no time, not read | kept | Kept. |
| web/staff.js:72 | Free call | No script | Matches the donor page picker. |
| web/staff.js:79-80 | PIN locked, nothing after the PIN, no PIN yet, nothing, not read | kept | Kept. |
| web/staff.js:110 | receipt cell aria `N sentences proven, N plain, N blocked` | kept | Kept, full meaning for screen readers. |
| web/staff.js:126-142 | mock, dry run, Call back, no (tags) | kept | Kept. |
| web/staff.js:153-164 | column headers PT, Started (PT), Call, The donor wanted, PayPal changed, PayPal now, Receipts, Callback, and the tooltip Sentences proven, plain and blocked | kept | Kept, short headers. |
| web/staff.js:178 | That staff key is not right. | That staff key didn't work. | Less blunt. |
| web/staff.js:179 | The staff view is off on this line. Set STAFF_KEY and restart it. | kept | Kept, it names the fix. |
| web/staff.js:180 | The record could not load. Please try again. | The calls didn't load. Please try again. | Names what failed. |
| web/staff.js:250 | No calls in the record yet. | No calls yet. | Shorter. |
| web/staff.js:271 | Loading the record. | Loading the calls. | Names what loads. |
| web/staff.js:278 | `N calls in the record, newest first. Loaded at T.` | `N calls, newest first. Updated at T.` | Shorter. |
| web/staff.js:293 | ` from the line's own limits, not a PayPal read (${source})` | ` is the line's own limit, not a PayPal read, ${source}` | No parentheses, same honesty. |
| web/staff.js:298-299 | ` from PayPal's ${what} read at T, which showed S` | ` from PayPal's ${what} record, read at T, which showed S` | Drops "read" as a noun. |
| web/staff.js:301 | debug id | kept | Kept. |
| web/staff.js:308 | Claim proven / Claim not proven, then the grader meaning | Backed by / Not backed, it needs, then the grader meaning | Reads as one sentence, as in "Backed by a PIN that passed in that turn". |
| web/staff.js:328 | Greeting, `Turn ${n}, at ${time}` | kept | Kept. |
| web/staff.js:332 | The donor said / keyed / typed | kept | Kept. |
| web/staff.js:348 | PayPal changed nothing in this call. | Nothing changed in PayPal on this call. | Same as the tile wording. |
| web/staff.js:352 | `${what} at T, debug id` | kept | Kept. |
| web/staff.js:365-371 | Run, Ended, The donor wanted, Gift now, Invoice now, Callback, Receipts, and values such as mock, does not count, still open, asked, call the donor back | kept | Kept, short labels. |
| web/staff.js:373-375 | What PayPal changed, Every sentence the line said | kept | Kept. |
| web/staff.js:376 | Proven means each amount, date and status in it matches a PayPal read earlier in the call, and each claim is backed by what PayPal returned. Plain means it states no fact. Blocked means the grader found a problem. | Proven means every amount, date and status in the sentence matches what PayPal returned earlier in the call, and anything it says happened, like a pause going through, shows in the call's record. Plain means there was nothing to check. Blocked means the check found a problem, so open those first. | The old line said each claim is backed by what PayPal returned, but a PIN claim is backed by the call record, not PayPal. The new one is accurate and gives an example. |
| web/staff.js:387 | Loading the call | kept | Kept. |
| web/staff.js:388 | Reading the record. | One moment. | The title above already says it is loading. |
| web/staff.js:426 | The staff key is at least 16 characters. | The staff key is at least 16 characters long. | Reads as a sentence. |
| web/staff.js:445 | The grid could not load. Reload the page. | The table didn't load. Please reload the page. | "Grid" is our word. Adds please. |

## What did not change

- Every element id, every event name, the gap timing code, `src/say.js`, `src/vocabulary.js` and the template lists.
- In `web/app.js` only string literals and one comment changed. The `CLAIM_LABELS` table gained a plain label for every claim the grader knows, so no chip shows the grader meaning as its text. That meaning is still on each chip as its title, prefixed "Backed by".
- "Start call" and "End call" stayed the same, since `web/chrome.js` reads "End call" to know a call is live.
