# Twilio setup

Every price and limit here comes from a page opened on Tue Nov 3, 2026, linked next to it. Where a page didn't say, this file says so. A second pass rechecked them against Twilio's pages the same day. No real Twilio has been called, so nothing here has been heard on a live call.

## The short answer

A judge can't call a trial number, so a real line needs an upgraded account and a number you buy. The number is $1.15 a month. One Script 2 call comes to about $0.12. Render's free plan sleeping is the one thing that will break a judge's first call, so plan on Render's paid plan, $7 a month, while judges are calling.

Nothing merges until the pilot is graded on Wed Nov 4 at 9 pm PT. Don't do steps 4 to 6 before that.

## Prices

From [Twilio's US voice pricing page](https://www.twilio.com/en-us/voice/pricing/us), which says "Pricing current as of August 2026". Opened Nov 3, 2026.

| Item | Price |
|---|---|
| US local number | $1.15 a month |
| Inbound voice, local number | $0.0085 a minute |
| Speech recognition with Gather, "Twilio Picks Provider", the default | $0.02 per use |
| Basic voices, `man` and `woman` | Free |
| Premium voice, Standard | $0.0008 per 100 characters |
| Premium voice, Neural, the line's default | $0.0032 per 100 characters |
| Premium voice, Generative | $0.0130 per 100 characters |

A toll-free number is $2.15 a month with inbound at $0.0220 a minute, so it isn't worth it here.

Two things to know about those prices.

- The speech price is billed separately from the minutes. The pricing page says per use. A search result quoted an older Twilio page as $0.02 per 15 seconds of Gather, and the [speech recognition page](https://www.twilio.com/en-us/speech-recognition) no longer gives a number when opened. I went with the pricing page. Check the first real bill.
- The page doesn't say whether a Gather answered only by keypad still counts as a use. The estimate below counts every Gather, so it can only be high on that point.

### What one call costs

This is arithmetic from those prices, not a measurement. Script 2 speaks 743 characters over 4 Gathers, the replies after the greeting, the PIN, the request and the yes. The goodbye hangs up, so it has none. I assumed 2 billed minutes.

| Part | Sum | Cost |
|---|---|---|
| Speech recognition | 4 uses at $0.02 | $0.08 |
| Neural voice | 7.43 hundreds of characters at $0.0032 | $0.024 |
| Minutes | 2 at $0.0085 | $0.017 |
| Total | | about $0.12 |

So 20 judge calls come to about $2.40, plus the $1.15 for the number. Set `PHONE_VOICE=Polly.Joanna` to use the Standard voice, which takes the voice part down to about $0.006 a call. Twilio's [text-to-speech page](https://www.twilio.com/docs/voice/twiml/say/text-speech) says of the free basic voices, "Don't use these voices for production apps."

The line caps what a dialer can run up. It takes 20 new calls an hour from one number and 60 an hour in all, 40 turns a call, and it hangs up after 3 silences in a row. A call past the hourly cap gets a `<Reject>`, which [Twilio's page](https://www.twilio.com/docs/voice/twiml/reject) says is "without being billed" as long as it is the first verb.

## What a trial account can do

From [Twilio trial account](https://www.twilio.com/docs/usage/trials), last updated Oct 20, 2026, and [Try out Twilio Voice](https://www.twilio.com/docs/usage/trials/try-out-voice), last updated Sep 25, 2026. Both opened Nov 3, 2026.

- **Can any caller reach a trial number? No.** "You can only make or receive calls from verified numbers." An account can verify up to five numbers, and each person has to enter a code Twilio sends to their phone.
- **Could a judge call it? Not unless you verified that judge's own number first.** So a judge can't try it from the submission. That means upgrading, and the [upgrade page](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account) says Twilio removes the restriction when you do.
- **The number isn't yours.** "Trial numbers are shared Twilio-owned numbers, not dedicated numbers assigned to your account", and "You can't keep your trial number when you upgrade."
- **It may not reach this line at all.** The pages say trial accounts support custom TwiML, and Gather with speech and keypad is listed as supported. But inbound testing is described through the Console's built-in scenarios on Try out Voice, and neither page shows pointing a trial number at your own webhook. There is a Custom scenario. Whether it takes a URL I could not tell without opening the Console, which I was told not to do. You can look, free.
- **Limits.** 75 minutes in all, 10 minutes a call, 5 calls at once, 30 days. Voice stays inside your sign-up country.
- **The trial message.** I could not confirm what it says. An older Twilio help article, seen only as a search result since the page refused to open, says a short trial message plays before your TwiML. The current pages don't describe one. So I can't tell you the words, or whether a key press is needed. It would come before the line's own first sentence if it plays.

**Upgrade cost.** The current [upgrade steps](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account) say to load a starting balance and give no amount. Older Twilio [blog posts](https://www.twilio.com/en-us/blog/getting-the-most-out-of-your-voice-project) say $20, so expect about that and read the amount on the screen. The balance pays for the calls and the number.

## Steps for Arnav

Claude never enters keys, opens the Console or buys anything. Twilio's docs show two Console layouts, the current one and the Legacy Console, so both are here. They come from [Twilio's incoming call tutorial](https://www.twilio.com/docs/voice/tutorials/how-to-respond-to-incoming-phone-calls/node), opened Nov 3, 2026. If a label on your screen differs, trust your screen and tell me.

### Now, before the pilot is graded

1. **Upgrade.** In the Console, click the **Trial** banner, or **Upgrade your account**. In the Legacy Console click **Upgrade** at the top of the page. Create the profile, add your address, load the starting balance and add your payment details. Cost before you click, about $20, see above.
2. **Buy the number.** Current Console, go to **Communications**, **Numbers & senders**, the **Phone Numbers** tab, then **Set up a new phone number**. Fill in **Basic information**, click **Next**, click **Select** next to a US local number with Voice, click **Next**, then **Purchase** on **Review and buy number**. Legacy Console, on the **Develop** tab go to **Phone Numbers**, **Manage**, **Buy a number**, click **Buy**, then confirm. These are from Twilio's [current](https://www.twilio.com/docs/numbers-and-senders/add-numbers-and-senders) and [legacy](https://www.twilio.com/docs/phone-numbers/legacy-console/buy-a-phone-number) steps. Neither says the review screen shows the monthly fee, so if a fee shows and it isn't $1.15, stop and tell me. Twilio also says [you might need extra compliance steps](https://www.twilio.com/docs/usage/how-do-i) first, and doesn't say which apply to a voice-only number.
3. **Find the Auth Token.** Current Console, go to **Builder tools**, **API Key & creds**, **API Keys & auth tokens**, then click **Live Credentials**. Legacy Console, open the **Account** menu, then **Keys & Credentials**, **API keys & tokens**. These are from Twilio's [credentials guide](https://www.twilio.com/docs/global-infrastructure/manage-regional-api-credentials). Don't paste it into chat.

### After the pilot is graded and this branch is merged

4. **Set Render's values yourself.** In the Render Dashboard, open the `pledge-line` service, click **Environment**, and add the two below, then save and let it deploy.

   | Key | Value |
   |---|---|
   | `PHONE_ENABLED` | `true` |
   | `TWILIO_AUTH_TOKEN` | The token from step 3 |

   Leave `PUBLIC_BASE_URL` as it is if it already holds your Render address. If it holds anything else, every webhook is refused as a 403, since the line checks signatures against that exact address. Leave `PHONE_VOICE` unset for the default voice.

5. **Point the number at the line.** Use your real Render address.

   - Current Console. **Numbers & senders**, click your number, **Configuration details**, **Voice and emergency address**, **Edit configuration details**, then pick your region. In **Edit voice configuration** choose **Webhook, TwiML Bin, Function, Studio Flow, Proxy Service**, then **Use Webhooks**. Paste `https://YOUR-RENDER-URL/phone/voice` in **URL**, use POST, and click **Save**.
   - Legacy Console. **Active Numbers**, click your number, **Configure**, **Voice Configuration**. Set **A call comes in** to **Webhook**, paste `https://YOUR-RENDER-URL/phone/voice`, use POST, and click **Save configuration**.
   - **Status callback.** In the same form, set the call status URL to `https://YOUR-RENDER-URL/phone/status`, POST. No Twilio page I could open names this field. Third-party [setup guides](https://intercom.help/dfy-crm/en/articles/12395123-setting-up-webhooks-to-receive-incoming-calls-messages-and-status-updates-for-calls-for-twilio-users) call it **Call status changes**, under Voice Configuration, so look for that. Without it, a hang-up is only noticed by the 10 minute idle sweep, so a draft invoice stays open until then.
   - Don't add `#` overrides to these URLs.

6. **Test it yourself first.** After the service has been awake a minute, call from your own phone. Key the PIN, say "I want to stop my monthly gift", wait for the question to finish, say "yes", then say "goodbye". Then say "please restart my monthly gift" on a new call, so the gift is active for the next person. Check these on that first call, since the fake can't.
   - The first thing you hear is "This is an automated line, not a person." If Twilio plays something before it, write it down.
   - A "yes" said over the read-back does nothing, and the line then asks again.
   - The read-back says the money right. Twilio's [Say page](https://www.twilio.com/docs/voice/twiml/say) warns that speech can get amounts wrong, and `$25.00` has only been read by the fake.
   - A "yes" after the read-back works the first time. If the line keeps reading the question again after a real yes, tell me. It means the spoken floor or the confidence check below needs changing.
   - Open `/staff` and check the call is there with its receipts.

When you're done with the hackathon, release the number in the Console, or it keeps costing $1.15 a month.

Changing the Auth Token in Twilio makes every webhook a 403 until Render has the new one.

## What can break a live call

Twilio's limit first. [Twilio's webhook overrides page](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides), opened Nov 3, 2026, gives webhooks 5 seconds to connect and 15 seconds to answer, says "Twilio imposes a hard upper timeout of 15 seconds" on call requests, and by default retries once, only on a failed TCP or TLS connection. Everything below is measured against that.

### Render's free plan sleeping. This will break a first call.

[Render's free page](https://render.com/docs/free), opened Nov 3, 2026, says a free service spins down after 15 minutes with no traffic and takes "about one minute" to come back. The first draft of this file said a cold start measured on Nov 3 took 23 seconds, but no file in the repo records that run, so don't lean on it. Either is past 15, so the first caller after a quiet spell gets an error from Twilio. The same page says Render shows a loading page to browsers during spin-up. It doesn't say what a POST from Twilio gets, so a webhook may get that page instead.

Sleeping also wipes the free service's files and the line's calls in memory. A caller on a call when that happens hears the greeting again and has to key the PIN again. No yes carries over, which is the safe way round.

| Fix | Cost | Good and bad |
|---|---|---|
| Render's paid plan. **My pick for judging week.** | $7 a month, billed to the second. That figure is from a [Render staff reply](https://community.render.com/t/which-paid-plan-or-option-should-i-go/23883) and a search listing, since the pricing page gave no number when opened, so read it before you pay. The hackathon's $50 credit may cover it, and SETUP.md and PILOT.md still treat that as unconfirmed. | Render's [FAQ](https://render.com/docs/faq) says paid plans don't spin down. |
| A free uptime service that gets `/healthz` every 10 minutes | Free | One service awake all month uses about 744 of Render's 750 free hours. It also keeps the wipe away, but the page says Render "might restart a Free web service at any time". |
| A silent fallback in Twilio, a TwiML Bin of `<Response><Pause length="10"/><Redirect>https://YOUR-RENDER-URL/phone/voice</Redirect></Response>` | Free | The caller waits about 25 seconds in silence, which won't cover a full minute. Twilio's [availability page](https://www.twilio.com/docs/usage/security/availability-reliability) names the field **Primary handler fails**, in the number's voice section under Active Numbers. Twilio's [11200 page](https://www.twilio.com/docs/api/errors/11200) recommends a fallback in general, but this exact Bin is my idea, untested. Don't add words to it, since every spoken line comes from the call service. |

### A slow turn

A turn can wait on Gemini and on several PayPal reads. Covered Month's yes runs the most. So a turn still running at 11 seconds answers with a two second `<Pause>` and a `<Redirect>` back for the same turn, with no words of its own, and the caller hears a silence. The turn runs once, since it is keyed on the CallSid and the turn number. Nothing to pay.

### Gemini's free tier

The [rate limits page](https://aistudio.google.com/docs/rate-limits), opened Nov 3, 2026, doesn't print free tier numbers. It says to read your limits in AI Studio. So look there before a demo. The dry run spaces its turns 4.5 seconds apart for this reason.

A phone turn uses Gemini as a browser turn does. A bare yes or no and the PIN use no model, and no input never does, so Script 2 makes 2 model calls. When Gemini refuses or takes over 6 seconds, the router answers unclear and the line says it didn't catch that. So a limit never moves money or changes a gift, it makes the line deaf for a while, and a judge keeps hearing that it didn't catch that. Two or three people calling at once is where I would worry.

If that happens, wait a minute. If you expect several judges at once, put billing on the Gemini key, or use `ROUTER_MODE=haiku` with paid credit. I did not look up either price for this file, so read it first.

### The single shared test gift

Every caller gets the same gift, `DEMO_SUBSCRIPTION_ID`, and the same PIN, `PILOT_PIN`. So one judge pausing it means the next one hears it is suspended, and "there is nothing to pause right now". A cancel can't be undone, so one judge saying cancel ends the demo for everyone until you run `npm run seed` and set the new id in Render. Covered Month works once a year per gift by default, so only the first judge gets it. Two callers at once read and change the same gift.

What to do, at no cost.

- In the submission, tell judges to pause rather than cancel, and to restart it before hanging up.
- Open `/staff` before a live demo and restart the gift if it needs it, by calling and saying "please restart my monthly gift".
- Publish the PIN only with the sandbox note. It unlocks a fake gift and no real money moves.

A number per judge, or a gift per caller, is not built. Say if you want it.

### Things I can't test without a live call

- **Listening starts after the read-back.** This rests on Twilio's [Gather page](https://www.twilio.com/docs/voice/twiml/gather), which allows an empty `<Gather>`. It doesn't say what happens to speech or keys during a `<Say>` before one. The line's whole early yes rule on the phone leans on it, so step 6 checks it. A yes that starts over the last word and runs past it could still be heard.
- **A change of mind after a long pause.** The proposal's `speechTimeout` is 2 seconds, so "yes... wait, no" reaches the gate whole only when the pause is under 2 seconds. Past that, the yes has already gone. The line then says what PayPal now shows, and the caller can undo a pause by saying restart. A cancel can't be undone.
- **Speech recognition quality.** A misheard word costs a re-ask. A word misheard as "yes" is the risk, which the confidence floor and the read-back reduce and don't remove. The line passes no `hints`, since a hint of "yes" pulls an unclear word toward the one word that changes something.
- **The confidence floor of 0.5.** This is a guess. Twilio says the score isn't always sent.
- **The spoken floor of 150 ms a word.** This is also a guess, kept low on purpose. Twilio's page doesn't give speaking rates.

### Privacy

- The PIN and the digits heard before it passes never reach the logs or the ledger, as in the browser. The number Twilio sends in the webhook never reaches the ledger or the logs at all, in any form. A number the caller says out loud after the PIN is ordinary words, so it stays in the ledger and on the staff view like any other turn. The PIN guard and the hourly limit count a keyed hash of it, in memory only. The ledger keeps Twilio's CallSid, so you can find a call in Twilio's log.
- Twilio sees all of it. [Twilio's docs](https://www.twilio.com/docs/usage/trials/try-out-voice) say its Console shows the requests for a call, so expect the caller's number and what it heard to be there. I did not read how long Twilio keeps them. A spoken PIN also goes to the speech provider, so the keypad is the better way, and the greeting offers both. It's a demo PIN on a fake gift, and it matters more if this ever carries a real one.
- "Staff will call you back" has no number behind it on the staff view, for the same reason. Staff would find the caller by time in Twilio's call log.

## Doc caveat

Twilio's [webhook security page](https://www.twilio.com/docs/usage/webhooks/webhooks-security) says "Don't implement your own signature validation" and advises its SDK. This line was asked to use Node crypto, with no new dependency. `src/phone.js` follows the algorithm from [Twilio's security page](https://www.twilio.com/docs/usage/security), and a test checks it against that page's worked example, `L/OH5YylLD5NRKLltdqwSvS0BnU=`. The check sorts names the way the page describes and drops the port from an https URL as it says. The page doesn't cover a name sent twice, so that follows [Twilio's Node SDK](https://github.com/twilio/twilio-node/blob/main/src/webhooks/webhooks.ts), which dedupes and sorts the values. It covers form posts only, which is all a voice webhook sends here.

A signature has no timestamp, and neither Twilio page mentions replays, so a signed webhook someone saved stays valid until the Auth Token changes. So each `<Gather>` action URL carries a random key made for that call and held in memory. A saved webhook from before a restart gets the greeting and never counts as a turn, and no one can sign a URL with the new key without the token. A saved `/phone/voice` can still start a call that only hears the greeting, and that counts against the hourly limits.
