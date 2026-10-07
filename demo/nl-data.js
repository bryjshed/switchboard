/* Captured live on 2026-10-06 from POST /api/projects/{id}/ai/proposals (proposal a6ac9f50, left as a DRAFT).
   Variation ids are replaced by their names for legibility; everything else is as returned. */
window.SB_NL = {
  lede: 'Type what you want in plain English. Claude turns it into a typed flag change with a before/after diff, and nothing happens until a person applies it.',
  html: `
  <figure class="shot" data-zoom>
    <div class="chrome"><i></i><i></i><i></i><span>Flags → Ask AI</span></div>
    <img src="shots/ask-ai-dark.jpg" alt="Review the drafted change: planner-v2 in staging adds a rule, platform is ios and plan is pro, serve 10% compact and 90% control. Apply change or Discard." loading="lazy">
    <figcaption>Captured live from the product. The draft says what it will do in plain words, shows the exact rule it adds, and changes nothing until someone presses Apply.</figcaption>
  </figure>
  <div class="sim">
    <div class="sim-head"><h3>What came back</h3><span class="tag real">Captured live</span></div>
    <div class="msg user" style="justify-self:start;max-width:100%">Release planner-v2's compact variant to 10% of iOS users on the Pro plan in staging</div>
    <div class="msg bot" style="max-width:100%">Add a targeting rule in staging to serve the 'compact' variant to 10% of iOS users on the Pro plan, as requested for this release test.</div>
<pre class="code"><span class="c">// proposal · kind FLAG_UPDATE · status DRAFT</span>
{ <span class="k">"flagKey"</span>: <span class="s">"planner-v2"</span>, <span class="k">"envKey"</span>: <span class="s">"staging"</span>,
  <span class="k">"rules"</span>: [{
    <span class="k">"clauses"</span>: [
      { <span class="k">"attribute"</span>: <span class="s">"platform"</span>, <span class="k">"op"</span>: <span class="s">"IN"</span>, <span class="k">"values"</span>: [<span class="s">"ios"</span>] },
      { <span class="k">"attribute"</span>: <span class="s">"plan"</span>,     <span class="k">"op"</span>: <span class="s">"IN"</span>, <span class="k">"values"</span>: [<span class="s">"pro"</span>] }
    ],
    <span class="k">"serve"</span>: { <span class="k">"rollout"</span>: [
      { <span class="k">"variation"</span>: <span class="s">"compact"</span>, <span class="k">"weight"</span>: 10 },
      { <span class="k">"variation"</span>: <span class="s">"control"</span>, <span class="k">"weight"</span>: 90 } ] },
    <span class="k">"description"</span>: <span class="s">"10% of iOS Pro plan users get compact variant"</span>
  }] }</pre>
    <p class="note">Before the draft is shown, the server checks it against the flag: the flag must exist, and every variation and operator it names must be real, or it is rejected. Applying it then runs the same validation as a hand-made change, including weights that sum to 100.</p>
  </div>`,
};
