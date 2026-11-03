# Site copy, before and after

Every string a person can read or hear from a screen reader on the donor page and the staff view, on `feat/human-copy` from `pilot` at f157c55. "kept" means the words did not change from pilot. Line numbers are from the first pass. The second pass removed a few lines near the top of each HTML page, so some sit a few lines off. Rows marked "Second pass" changed after the review on Nov 3, and their "new" column is the final text.

What the line speaks lives in `src/say.js` and `src/vocabulary.js`. The pilot grader hashes those, so they are not here and did not change. The same goes for the script titles and the words after "What should happen", which come from `src/pilot-scripts.js`, and the error messages the server sends, which come from `src/server.js`.

## The headline

Now "Your gift, right from PayPal". The first pass kept "Every word backed by PayPal", and the review showed it was not true. In Script 2, 16 of 23 sentences have nothing to check, such as "What would you like to do?", and the PIN claims rest on the call's own record, not on PayPal. The new line is true for every fact about the gift, which is what the chips show.

"Your gift, straight from PayPal" was tried first. It wrapped to three lines at 390 px, so "right from PayPal", about as long as the old second line, replaced it. It fits on one line at 390 px.

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
| web/index.html:49 | PayPal sandbox. No real money moves. | A demo, no real money. | Second pass. The same disclaimer showed four times in two words, sandbox and test system. The hero note keeps the full one. |
| web/index.html:51 | MIT license | removed | Second pass. The license sat where social links go and meant nothing to a donor. The footer says it. |
| web/index.html:52 | Sandbox only | removed | Second pass. The menu already says it is a demo. |
| web/index.html:62 | Pledge Line. | kept | Kept, already plain. |
| web/index.html:63 | the after-hours donor line for small nonprofits | kept | Kept, already plain. |
| web/index.html:64 | Every word | Your gift, | Second pass, see The headline. |
| web/index.html:65 | backed by PayPal | right from PayPal | Second pass, see The headline. About as long, so it stays on one line at 390 px. |
| web/index.html:70 | Start a call | kept | Kept, already plain. |
| web/index.html:70 | Start a call | kept | Kept, already plain. |
| web/index.html:75 | PayPal sandbox demo. No real money moves, and no real donor is called. | This is a demo on PayPal's test system. No real money moves, and the gift belongs to a test account. | Donors call the line, so "no real donor is called" read backwards. Second pass. A donor is a person, not an account, so the account is the gift's. It is now set in sentence case, not capitals, in style.css. |
| web/index.html:78 (aria-label) | The call | kept | Kept, already plain. |
| web/index.html:81 | Your call | kept | Kept, already plain. |
| web/index.html:82 | Mute the line's voice | kept | The first pass had "Mute the voice". The second pass put the old words back, since a screen reader user could take "the voice" for their own microphone. |
| web/index.html:84 | No call yet. Press Start call. | Press Start call when you're ready. | Drops the empty "No call yet" and says the next step warmly. |
| web/index.html:85 | Start call | kept | Kept, already plain. |
| web/index.html:88 | The line says | kept | Kept, already plain. |
| web/index.html:92 | You said | kept | Kept, already plain. |
| web/index.html:97 | Hold to talk | kept | Kept, already plain. |
| web/index.html:98 | Hold the button, or the Space bar, while you speak. Let go when you finish. | Hold this button or the Space bar while you talk, and let go when you're done. | One sentence, everyday words. |
| web/index.html:103 | PIN keypad | Your PIN | Second pass. "PIN keypad" labelled something that is plainly a keypad. |
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
| web/index.html:141 | Last gap | Reply time. Last one | "Gap" is grader jargon. Second pass. The first pass's "Wait for a reply, last turn" read as an order to wait. |
| web/index.html:141 | none yet | kept | Kept, already plain. |
| web/index.html:141 | . Median of voice turns | . Typical spoken reply | Second pass. "median" is a stats word, and replies are called replies everywhere else. |
| web/index.html:141 | none yet | kept | Kept, already plain. |
| web/index.html:141 | . | kept | Kept. |
| web/index.html:147 | Every sentence, with its PayPal read | removed | Second pass. The first pass's "Every sentence, checked against PayPal" was not true. Plain sentences are not checked, and a PIN claim is checked against the call's record. The title and hint already explain the panel. |
| web/index.html:148 | What the line said | kept | Kept, already plain. |
| web/index.html:149 | Each sentence with a fact in it shows the PayPal read behind it. Times are Pacific. | When a sentence has an amount, a date, a status or a change in it, you can see what PayPal said and when. Times are Pacific. | Names the facts instead of the abstract "fact". Second pass. Adds status, which the chips also show. |
| web/index.html:150 | Nothing said yet. | kept | Kept, already plain. |
| web/index.html:151 (aria-label) | Everything the line said, with receipts | Everything the line said, with what backs it | Second pass. The first pass's "with the proof for each sentence" claimed proof for plain sentences too. |
| web/index.html:157 | PayPal's record | kept | Kept, already plain. |
| web/index.html:159 | Waiting for your yes | kept | Kept, already plain. |
| web/index.html:165 | Monthly gift | kept | Kept, already plain. |
| web/index.html:166 | not read yet | not checked yet | Second pass. "checked" is the one verb the page now uses for looking at PayPal. |
| web/index.html:167 | Not read from PayPal yet. | Not checked with PayPal yet. | Same. |
| web/index.html:170 | Amount | kept | Kept, already plain. |
| web/index.html:170 | not read yet | not checked yet | Same. |
| web/index.html:171 | Next date | Next payment | Next date of what. It is the next payment. |
| web/index.html:171 | not read yet | not checked yet | Same. |
| web/index.html:172 | Debug id | PayPal reference | Second pass. "debug id" is developer talk on the donor page. It is the id to quote to PayPal. |
| web/index.html:172 | none | kept | Kept, already plain. |
| web/index.html:177 | One-time gift invoice | kept | Kept, already plain. |
| web/index.html:178 (new) | none | No one-time gift on this call. | Second pass. Five rows of "none" looked broken. With no invoice, app.js leaves the number and status empty and style.css shows this one line instead of the rows. |
| web/index.html:179 | Invoice number | kept | Kept, already plain. |
| web/index.html:179 | none | empty, see the line above | Second pass. |
| web/index.html:180 | Status | kept | Kept, already plain. |
| web/index.html:180 | none | empty, see the line above | Second pass. |
| web/index.html:181 | Amount | kept | Kept, already plain. |
| web/index.html:181 | none | kept | Kept, already plain. |
| web/index.html:182 | Debug id | PayPal reference | Second pass, same as the gift card. |
| web/index.html:182 | none | kept | Kept, already plain. |
| web/index.html:183 | Payer page | Payment page | "Payer" is PayPal jargon. |
| web/index.html:183 | none | kept | Kept, already plain. |
| web/index.html:188 | Event log | kept | Kept, already plain. |
| web/index.html:189 | Newest first. Every PayPal read and change shows here. | Newest first. Every time the line read or changed something in PayPal, it shows here. | Drops "read" as a noun. |
| web/index.html:190 (aria-label) | Event log, newest first | kept | Kept, already plain. |
| web/index.html:195 | Pledge Line pilot, MIT license. PayPal sandbox only. | Pledge Line, open source under MIT. | Second pass. One disclaimer is enough, and the hero note has it. |
| web/index.html:196 | ©2026 | kept | Kept. |
| web/index.html:202 (title) | Background sound | kept | Kept, already plain. |
| web/index.html:205 | Background sound | kept | Kept, already plain. |
| web/index.html:209 | PayPal | kept | Kept, already plain. |
| web/index.html:211 | record | kept | Kept, already plain. |
| web/index.html:212 | PayPal's record | kept | Kept, already plain. |
| web/index.html:214 | ©2026 | kept | Kept. |
| web/staff.html:6 | Pledge Line staff view | Pledge Line, staff | Shorter tab title. |
| web/staff.html:7 (meta description) | The morning after. Every call the line took, what PayPal changed, and the PayPal read behind every sentence the line said. | For the nonprofit's staff. Every call the line took overnight and what it changed in PayPal. | Says who it is for. Second pass. Drops "the morning after" and the list of three. |
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
| web/staff.html:50 | PayPal sandbox. No real money moves. | A demo, no real money. | Same as the donor page menu. |
| web/staff.html:52 | MIT license | removed | Same as the donor page menu. |
| web/staff.html:53 | Sandbox only | removed | Same as the donor page menu. |
| web/staff.html:61 | Staff view, Pledge Line | kept | Kept, already plain. |
| web/staff.html:62 | the morning | last night's | Second pass. "the morning after" also reads as a hangover or the pill, and it did not say what the page is. |
| web/staff.html:62 | after | calls | Same. |
| web/staff.html:63 | Every call the line took, what PayPal changed, and the PayPal read behind every sentence the line said. | Every call the line took, and what it changed in PayPal. | Second pass. The first pass kept a tidy list of three. |
| web/staff.html:64 | This is a PayPal sandbox demo. No real money moves. Only staff with the key can read this record. | This is a demo on PayPal's test system. No real money moves. You need the staff key to see the calls. | Plain words. Second pass. Set in sentence case, not capitals, in staff.css. |
| web/staff.html:68 | Staff key | kept | Kept, already plain. |
| web/staff.html:69 | Type the staff key set as STAFF_KEY for this line. This tab keeps it until you close it, and nothing else stores it. | Enter the staff key you were given. This tab keeps it until you close it, and nothing else saves it. | Second pass. A volunteer should not see an environment variable name. |
| web/staff.html:71 | Staff key | kept | Kept, already plain. |
| web/staff.html:74 | Open the record | Show the calls | Says what the button shows. |
| web/staff.html:81 (aria-label) | Totals for the calls shown | kept | Kept, already plain. |
| web/staff.html:82 | 0 | kept | Kept. |
| web/staff.html:82 | calls | kept | Kept, already plain. |
| web/staff.html:83 | 0 | kept | Kept. |
| web/staff.html:83 | sentences proven | proven sentences | Second pass. The three tiles now share one word order. |
| web/staff.html:84 | 0 | kept | Kept. |
| web/staff.html:84 | plain sentences | kept | Kept, already plain. |
| web/staff.html:85 | 0 | kept | Kept. |
| web/staff.html:85 | sentences blocked | blocked sentences | Same. |
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
| web/staff.html:123 | Pledge Line pilot, MIT license. PayPal sandbox only. Grid by AG Grid Community, | Pledge Line, open source under MIT. Table by AG Grid Community, | Second pass. Same footer as the donor page, and "table" over "grid". |
| web/staff.html:123 | MIT license | kept | Kept, already plain. |
| web/staff.html:123 | . | kept | Kept. |
| web/staff.html:124 | ©2026 | kept | Kept. |

## Scripts (string literals shown to people)

| where | old | new | why |
| --- | --- | --- | --- |
| web/app.js:28 | Active, Suspended, Cancelled, Expired, Waiting for approval (status words) | Active, Paused, Cancelled, Expired, Waiting for approval | Second pass. The donor asked to pause and the line offered a pause, so the card says Paused. The gift card adds "PayPal's word for a pause is suspended." once, since the line speaks PayPal's word. |
| web/app.js:36 | pin_ok chip `PIN passed` | `PIN accepted` | Same words the status line and event log use. |
| web/app.js:36 | pin_bad chip, fell back to `Checked, a wrong PIN in that turn` | `Checked against your PIN` | Every claim now has a plain label. Second pass. The first pass's "That PIN didn't match" repeated its own sentence word for word. |
| web/app.js:36 | tries_left chip, fell back to `Checked, a wrong PIN in that turn that left that many tries` | `Counted on this call` | Second pass. "Tries left, counted on this call" was a clipped noun phrase. |
| web/app.js:36 | pin_locked chip, fell back to `Checked, a lock in that turn` | `Call locked after wrong PINs` | Plain label, full meaning in the title. |
| web/app.js:37 | pin_limit chip, fell back to `Checked, a pin_limit refusal in that turn` | `Too many wrong PINs from here` | Removes a code name from the page. Meaning in the title. |
| web/app.js:37 | not_verified chip `No PIN yet` | kept | Kept, already plain. |
| web/app.js:38 | wrote chip `PayPal accepted the change` | kept | The first pass had "PayPal confirmed the change". The review showed that was not always true. The claim proves PayPal accepted the request, and it also sits next to "I asked PayPal to pause it." and "It can take a minute to update." when the read-back does not show the change yet. The line keeps "confirm" for after a read-back. |
| web/app.js:38 | wrote_suspend chip `PayPal accepted the pause` | `PayPal took it as a pause, not a cancel` | True whether or not the read-back shows it yet, and it says why "You can restart it any time." holds. It also stops two chips in one reply from saying the same thing. |
| web/app.js:38 | wrote_activate chip `PayPal accepted the restart` | kept | The first pass's "confirmed" was taken back, as above. |
| web/app.js:39 | wrote_cancel chip `PayPal accepted the cancel` | `PayPal accepted the cancellation` | "The cancel" is not how people talk. "Accepted" stays, as above. |
| web/app.js:39 | wrote_send_invoice chip `PayPal accepted the send` | `PayPal agreed to send it` | "The send" is not how people talk. "Agreed" is true for an accepted request, unlike the first pass's "confirmed it sent". |
| web/app.js:40 | write_failed chip, fell back to `Checked, a subscription write PayPal refused in that turn, with a 4xx or a read after it that does not show the change` | `PayPal turned down the change` | The worst of the grader text on the page. Full meaning stays in the title. |
| web/app.js:40 | send_failed chip, fell back to `Checked, a send PayPal refused in that turn, with a 4xx ...` | `PayPal turned down the send` | Same. |
| web/app.js:40 | write_unclear chip, fell back to `Checked, a write in that turn that PayPal gave no clear answer to, and a read of its target after it` | `PayPal gave no clear answer` | Same. |
| web/app.js:41 | gift_unread chip, fell back to `Checked, a subscription write in that turn whose latest read after it found nothing` | `PayPal didn't return the gift after the request` | Matches the spoken sentence. Second pass. The first pass's "found no gift after the change" said a change happened, and the claim holds even when it did not. |
| web/app.js:41 | invoice_unread chip, fell back to `Checked, a send in that turn whose latest read after it found nothing` | `PayPal didn't return the invoice after the request` | Same. |
| web/app.js:42 | draft_deleted chip, fell back to `Checked, a delete of this call's own draft in that turn, a read after it that PayPal answered with 404, and no send of it` | `Draft deleted, PayPal no longer finds it` | Same. "No longer finds it" is the 404 in plain words. |
| web/app.js:42 | draft_kept chip, fell back to `Checked, a delete of this call's own draft in that turn, and a read after it that still finds the draft` | `The draft is still in PayPal` | Same. |
| web/app.js:43 | no_gift chip, fell back to `Checked, a read of the call's own subscription in that turn that found nothing` | `PayPal found no monthly gift` | Same. |
| web/app.js:43 | no_email chip, fell back to `Checked, a read of the call's own subscription in that turn with no email on file` | `PayPal has no email on file` | Same. |
| web/app.js:43 | paypal_unclear chip, fell back to `Checked, a PayPal step in that turn that failed, found nothing, or made a draft it deleted, and no ok write` | `No clear answer from PayPal` | Second pass. "A PayPal step didn't go through" was false for a draft the line made and deleted, which did go through. Matches the spoken "I couldn't get a clear answer from PayPal". |
| web/app.js:44 | unchanged chip `Nothing changed in PayPal` | kept | Kept, already plain. |
| web/app.js:44 | no_pause chip, fell back to `Checked, a no to a pause in that turn, and no ok write` | `You said no, nothing changed` | The example Arnav flagged. Meaning in the title. |
| web/app.js:44 | email_refused chip, fell back to `Checked, an other_email refusal in that turn` | `New email turned down` | Removes a code name. Meaning in the title. |
| web/app.js:45 | set_aside chip `Request set aside, nothing changed` | `Set aside, nothing changed` | Shorter. |
| web/app.js:45 | callback_noted chip, fell back to `Checked, a staff callback logged in that turn` | `Call back noted for staff` | Plain label. |
| web/app.js:45 | turn_limit chip, fell back to `Checked, a turn_limit refusal in that turn` | `The call reached its limit` | Removes a code name. |
| web/app.js:46 | timed_out chip, fell back to `Checked, a proposal that timed out since the line last said so, and no ok write in that turn` | `Timed out, nothing changed` | Plain label. |
| web/app.js:46 | nothing_pending chip, fell back to `Checked, no proposal still open` | `Nothing waiting for a yes` | Plain label. |
| web/app.js:46 | call_ended chip, fell back to `Checked, a call_end before it` | `The call had ended` | Removes a code name. |
| web/app.js:47 | gift_read chip `PayPal read of your gift` | `Checked your gift in PayPal` | A verb instead of "read" as a noun. Second pass. "checked" is the page's one verb for looking at PayPal. |
| web/app.js:47 | gift_active chip, fell back to `Checked, a read of the call's own subscription that shows it active` | `PayPal shows the gift active` | Plain label. |
| web/app.js:47 | nothing_to chip, fell back to `Checked, a read of the call's own subscription whose status that change can't act on` | `PayPal shows nothing to change` | The example in the brief. Full meaning in the title. |
| web/app.js:48 | invoice_read chip `PayPal read of the draft` | `Checked the draft in PayPal` | Same. |
| web/app.js:48 | gift_rechecked chip `Fresh PayPal read in this reply` | `Checked PayPal again for this answer` | Second pass. The first pass's "Read PayPal again for this answer" read as an order to the donor. |
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
| web/app.js:111 | `Expected. ${expected}.` | `This script should end like this. ${expected}.` | Second pass. "What should happen." was a fake sentence. The words after it still come from src/pilot-scripts.js, out of scope here. |
| web/app.js:123 | `Script ${n}, ${title}` | kept | Kept. |
| web/app.js:178 | `Read from PayPal at ${time}, status ${rawStatus}.` | `Checked with PayPal at ${time}.`, plus " PayPal's word for a pause is suspended." when the gift is paused | Second pass. The raw uppercase status shouted and repeated the big status word above it. |
| web/app.js:195 | `Changed during this call, ${from} to ${to}.` | `Paused on this call. It was active before.` / `Restarted on this call. It was paused before.` | Second pass. Says what happened in the donor's words. |
| web/app.js:205 | Not read from PayPal yet. | Not checked with PayPal yet. | Same as the HTML. |
| web/app.js:217-225 | Not found, not read yet, none, not found, deleted (gift and invoice card values) | Not found, not checked yet, Nothing scheduled, not found, deleted, and empty for the invoice number and status | Second pass. "none" for the next payment of a paused gift read like an error. The empty invoice values let the card show one line. |
| web/app.js:232 | Open the PayPal payer page | Open PayPal's payment page | "Payer page" is PayPal jargon. |
| web/app.js:242 | `${label}. Nothing changes in PayPal until you say yes.` | kept | Kept, it is the key promise and already plain. |
| web/app.js:244 | `This request times out at ${time}.` / `This request times out soon.` | `The line will wait for your yes or no until ${time}.` / `The line will wait a few minutes for your yes or no.` | "Times out" is software talk. Second pass. "It waits" did not say what "it" was. |
| web/app.js:266-267 | read chip key `read ${time}`, fallback `in this call` | `at ${time}`, fallback `some point in this call` | Feeds the chip below. Only the words changed, the grouping key is still one per read time. |
| web/app.js:274 | `The line's own limit, ${values}` | kept | Kept, honest that it is not a PayPal read. |
| web/app.js:276 | chip title `PayPal ${what} ${id}, debug id ${debugId}` | `Checked the gift in PayPal, reference ${debugId}` | Second pass. "plan" and "subscription" are PayPal's own objects, so the hover names the gift or the gift amount. |
| web/app.js:277 | chip `PayPal, read 5:42:07 pm, $25.00, suspended` | `From PayPal at 5:42:07 pm, $25.00, suspended` | Reads as words instead of a log line. |
| web/app.js:281 | claim chip title `Checked, ${meaning}` and the no-label fallback text `Checked, ${meaning}` | a plain sentence from web/claim-words.js, as in "The PIN matched on this reply." | Second pass. The first pass's "Backed by an ok write in that turn" was still grader text. claim-words.js says each of the 35 claims in plain words, and a claim missing there still falls back to the grader's meaning. |
| web/app.js:300 | Not backed by PayPal | This didn't check out | Second pass. Matches the summary line's "checked out". |
| web/app.js:314 | Greeting, `Reply ${n}` | kept | Kept. |
| web/app.js:326 | Nothing said yet. | kept | Kept. |
| web/app.js:327 | `N sentences said. P proven against this call's record, Q with nothing to prove, R not backed.` | `The line has said N sentences. C had something to check. All C checked out.` (or `R didn't check out. Those are marked in red.`) | Second pass. The first pass's three-part tally read like an audit. |
| web/app.js:337 | Call started. | kept | Kept. |
| web/app.js:338 | `Heard by ${source}, "${text}".` (as in Heard by typed) | `You typed "..."` / `You said "..."`, and for a PIN `Got a PIN from the keypad.`, `Got a typed PIN.` or `Heard a PIN.` | Second pass. The first pass quoted four # marks and said it "heard" a keypad. No extra period after a quote that ends in one. |
| web/app.js:339-340 | PIN accepted. / Wrong PIN. | kept | Kept. |
| web/app.js:341 | Too many wrong PINs, so the call is locked. | Too many wrong PINs. The call is locked. | Two short sentences. |
| web/app.js:342 | `Understood as ${intent}.` | one sentence per request, as in `Took that as a request to stop the gift.` and `Took that as asking how the line knows.` | Second pass. Intent codes with spaces read as "Understood as how do you know". A yes or a no, which routes as unclear, shows as `That wasn't a request on its own.` |
| web/app.js:344 | `Read the ${what} from PayPal, which says it is not found.` | `Asked PayPal for the gift. PayPal couldn't find it.` | Plain order of events. Second pass. Names the gift, the gift amount or the invoice instead of PayPal's objects. |
| web/app.js:345 | `Could not read the ${what} from PayPal, ${error}.` | `Couldn't check the gift in PayPal, ${error}.` | Same. |
| web/app.js:346 | `Read the ${what} from PayPal, status X, debug id Y.` | `Checked the gift in PayPal. It shows paused, reference Y.` / `Checked the gift amount in PayPal, reference Y.` | Second pass. No "plan", "subscription", raw SUSPENDED or "debug id". |
| web/app.js:347 | `Asked for a yes before ${what}.` | `Asked for your yes before ${what}.` | Second pass. Speaks to the donor, like the rest of the log. |
| web/app.js:348 | Heard a clear yes in its own turn, so a one-time write token was issued. | You said yes, so the line can make this one change. | Second pass. The first pass's "may" read as permission or chance, and "on its own" needed grader context. |
| web/app.js:349 | Heard a no. | You said no. | Second pass. Matches "You said yes". |
| web/app.js:350 | `PayPal accepted ${what}, debug id X.` / `PayPal did not accept ${what}, ${error}.` | `PayPal accepted the request to pause the monthly gift, reference X.` / `PayPal turned down the request to pause the monthly gift, ${error}.` | Second pass. The first pass's "PayPal said yes to" blurred the donor's yes with PayPal's answer. "Accepted the request" is what an ok write proves. |
| web/app.js:352 | `Created a private draft invoice, ${id}.` / Could not create a draft invoice. | `Made a draft invoice, ${id}. It isn't sent.` / Couldn't make a draft invoice. | "Private" was vague. Says the fact, it is not sent. |
| web/app.js:353 | `Could not delete the draft invoice ${id}.` | `Couldn't delete the draft invoice ${id}.` | Contraction. |
| web/app.js:354 | `Refused, ${reason}.` | `Turned that down because ${reason}.` | Softer. Second pass. "because" joins the reason. |
| web/app.js:355 | The pending request timed out, nothing changed. | No answer in time, so nothing changed. | No "pending request" jargon. |
| web/app.js:356 | The pending request was dropped. | The request was set aside. | Matches the chip and what the line says. |
| web/app.js:357 | Noted a request for a staff callback. | Noted that you want a call back from staff. | Speaks to the donor. |
| web/app.js:358 | `Call ended, ${reason}.` | `Call ended after you said goodbye.`, `Call ended, locked after wrong PINs.`, `Call ended after a long quiet.` or `Call ended when the page closed.` | Second pass. The raw reason showed as "Call ended, client." An unknown reason still shows as before. |
| web/app.js:398 | End call / Start call | kept | Kept. chrome.js also reads "End call" to know a call is live. |
| web/app.js:405 | This call is locked after too many wrong PINs. | kept | Kept. |
| web/app.js:406, 488 | Call ended. Press Start call for a new one. | kept | Kept. |
| web/app.js:407 | Enter your PIN on the keypad, or say its digits. | Enter your PIN on the keypad, or say the numbers. | "Numbers" over "digits". |
| web/app.js:408 | `Verified. Running script ${n}.` / Verified. Ask about your monthly gift. | `PIN accepted. Say the next line from Script ${n} once the line stops talking.` / PIN accepted. Go ahead and ask about your monthly gift. | Second pass. "Running script 2" was tester talk and never said what to do next. |
| web/app.js:441 | `${s}, muted` / `${s}, the reply never started` | `${s}, muted` / `${s}, the reply didn't play` | Plainer. |
| web/app.js:444 | `${s} over ${n} turns` | `${s} over ${n} replies` | Second pass. Replies are called replies everywhere on the page. |
| web/app.js:598 | No digits yet | No numbers yet | Matches the HTML. |
| web/app.js:669 | Hold to talk is not available here | Talking isn't available in this browser | Says where. |
| web/app.js:670 | This browser has no speech input, so use the typed box below. | This browser can't listen, so please type below. | No "speech input" or "typed box". |
| web/chrome.js:418 | `Background sound, on` / `Background sound, off` (title) | kept | Kept, already plain. |
| web/staff.js:21 | hear the gift | check the gift | What the donor wanted, in their words. |
| web/staff.js:21-23 | stop the gift, cancel now, pause the gift, restart the gift, one-time gift, how do you know, repeat, help, a call back, goodbye, unclear | stop the gift, cancel now, pause the gift, restart the gift, give once, ask how the line knows, hear it again, help, a call back, say goodbye, unclear | Second pass. "The donor wanted how do you know" was broken. Each now reads after "The donor wanted". |
| web/staff.js:22 | a new email, refused | use a new email, turned down | Same word as the donor page, and reads after "The donor wanted". |
| web/staff.js:26-31 | paused the gift ... refused the delete (what PayPal changed) | kept | Kept, short and clear in the grid. |
| web/staff.js:34 | Proven, Plain, Blocked (badges) | kept | Kept as the staff page's three terms. The grid's search and sort use them, and the hint below explains them. |
| web/staff.js:35 | closed by the page | page closed | Shorter. |
| web/staff.js:35 | said goodbye, locked after wrong PINs, went idle | kept | Kept. |
| web/staff.js:55-60 | not yet, no time, not read | kept, and SUSPENDED shows as paused | Second pass. The staff row showed "paused the gift" beside "gift suspended" for one event. |
| web/staff.js:72 | Free call | No script | Matches the donor page picker. |
| web/staff.js:79-80 | PIN locked, nothing after the PIN, no PIN yet, nothing, not read | kept | Kept. |
| web/staff.js:110 | receipt cell aria `N sentences proven, N plain, N blocked` | kept | Kept, full meaning for screen readers. |
| web/staff.js:126-142 | mock, dry run, Call back, no (tags) | test, dry run, Call back, no | Second pass. "mock" is developer talk. Searching "mock" still finds those calls. |
| web/staff.js:153-164 | column headers PT, Started (PT), Call, The donor wanted, PayPal changed, PayPal now, Receipts, Callback, and the tooltip Sentences proven, plain and blocked | kept | Kept, short headers. |
| web/staff.js:178 | That staff key is not right. | That staff key didn't work. | Less blunt. |
| web/staff.js:179 | The staff view is off on this line. Set STAFF_KEY and restart it. | The staff view is off on this line. Whoever runs the line can turn it on by setting STAFF_KEY. | Second pass. Tells a volunteer who can fix it, and keeps the fix for that person. |
| web/staff.js:180 | The record could not load. Please try again. | The calls didn't load. Please try again. | Names what failed. |
| web/staff.js:250 | No calls in the record yet. | No calls yet. | Shorter. |
| web/staff.js:271 | Loading the record. | Loading the calls. | Names what loads. |
| web/staff.js:278 | `N calls in the record, newest first. Loaded at T.` | `N calls, newest first. Updated at T.` | Shorter. |
| web/staff.js:293 | ` from the line's own limits, not a PayPal read (${source})` | `, the line's own limit, not from PayPal` | No parentheses. Second pass. The field name moves into the hover. |
| web/staff.js:298-299 | ` from PayPal's ${what} read at T, which showed S` | `, from PayPal's gift record at T` (the gift plan record for the amount) | Second pass. The first pass said "active" twice in one line, as in "active from PayPal's gift record, which showed active". |
| web/staff.js:301 | debug id, then the field, such as plan.price | PayPal reference, and the field only in the hover | Second pass. Code field paths are not for staff. |
| web/staff.js:308 | Claim proven / Claim not proven, then the grader meaning | `Backed,` then a plain sentence from web/claim-words.js / `Not backed, the record doesn't show that` then the same sentence | Second pass. The first pass's "Backed by an ok write in that turn" was grader text in the page a volunteer reads. |
| web/staff.js:328 | Greeting, `Turn ${n}, at ${time}` | Greeting, `Reply ${n}, ${time}` | Second pass. The donor page calls the same thing a reply. |
| web/staff.js:332 | The donor said / keyed / typed | The donor said / entered / typed | Second pass. "keyed" is an odd verb. |
| web/staff.js:348 | PayPal changed nothing in this call. | Nothing changed in PayPal on this call. | Same as the tile wording. |
| web/staff.js:352 (debug id) | `, debug id` | `, PayPal reference` | Second pass, same as the donor page. |
| web/staff.js:352 | `${what} at T, debug id` | kept | Kept. |
| web/staff.js:365-371 | Run, Ended, The donor wanted, Gift now, Invoice now, Callback, Receipts, and values such as mock, does not count, still open, asked, call the donor back | kept labels. Run says `Test call, not counted`, `Dry run, not counted` or `PayPal's test system`. Gift now and Invoice now say `checked at` | Second pass. "mock, does not count" is developer talk, and "checked" matches the donor page. |
| web/staff.js:373-375 | What PayPal changed, Every sentence the line said | kept | Kept. |
| web/staff.js:376 | Proven means each amount, date and status in it matches a PayPal read earlier in the call, and each claim is backed by what PayPal returned. Plain means it states no fact. Blocked means the grader found a problem. | Proven means each amount, date and status matched what PayPal sent earlier in the call. Anything it says happened also shows in the call's record. Plain means there was nothing to check. Blocked means the check failed, so look at those first. | The old line said each claim is backed by PayPal, but a PIN claim is backed by the call record. Second pass. One long sentence split into short ones. |
| web/staff.js:387 | Loading the call | kept | Kept. |
| web/staff.js:388 | Reading the record. | One moment. | The title above already says it is loading. |
| web/staff.js:426 | The staff key is at least 16 characters. | The staff key is at least 16 characters long. | Reads as a sentence. |
| web/staff.js:445 | The grid could not load. Reload the page. | The table didn't load. Please reload the page. | "Grid" is our word. Adds please. |

## Also changed in the second pass

- `web/claim-words.js` is new. It says what each of the 35 claims means in plain words, as in "PayPal accepted a pause on this reply". The donor page's chip titles and the staff view's details both read it, so the two pages say the same thing. Both HTML pages load it before their own script.
- `src/staff.js` HIDDEN_PIN went from "(PIN entry, hidden)" to "a PIN, not shown here", without the parentheses, so the staff view reads "The donor entered a PIN, not shown here". `test/staff.test.js` checks the new text. The grader does not read either.
- `web/style.css` and `web/staff.css`: the two full-sentence notes, the hero note and the staff note, are now in sentence case at a slightly larger size, since capitals are hard to read in a whole sentence. The short labels, such as YOU SAID and REPLY 3, stay in capitals as part of the unseen look.
- `web/style.css` shows "No one-time gift on this call." in place of the invoice rows until the call has an invoice.

## What did not change

- Every element id, every event name, the gap timing code, `src/say.js`, `src/vocabulary.js`, `src/pilot-scripts.js` and the template lists. The line still says "suspended" and "say its digits", and the expected line still says "No writes". Those wait until after the pilot.
- In `web/app.js` the first pass changed only string literals and one comment. The second pass added small word tables beside them (STATUS_NOTES, CHANGE_WORDS, REQUESTS, READ_NAMES, INTENT_WORDS, END_WORDS) and the lookups that pick from them in the event log, the gift card and the receipt summary. Nothing in the call, the timing or what the page sends changed.
- "Start call" and "End call" stayed the same, since `web/chrome.js` reads "End call" to know a call is live.
