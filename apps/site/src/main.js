import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";

const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:18787";
const DASHBOARD = import.meta.env.VITE_DASHBOARD_URL ?? "http://localhost:5183/";

for (const link of document.querySelectorAll("[data-dashboard]")) link.href = DASHBOARD;

const VERDICTS = { ALLOW: "Cleared", REDUCE: "Cleared, reduced", BLOCK: "Refused", HUMAN_REQUIRED: "Needs the owner" };

function show(element, tone, lines) {
  element.className = `result ${tone}`;
  element.replaceChildren(
    ...lines.map(([label, value, mono]) => {
      const row = document.createElement("div");
      if (label) {
        const name = document.createElement("span");
        name.textContent = label;
        row.append(name);
      }
      const content = document.createElement(mono ? "code" : "b");
      content.textContent = value;
      row.append(content);
      return row;
    }),
  );
}

const offline = (element) =>
  show(element, "bad", [["", "The API isn't reachable from here. Start it with pnpm start."]]);

const proofForm = document.getElementById("proof-form");
proofForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.getElementById("proof-result");
  const id = document.getElementById("proof-id").value.trim();
  try {
    const response = await fetch(`${API}/v1/proofs/${encodeURIComponent(id)}`);
    const proof = await response.json();
    if (!response.ok) return show(output, "bad", [["", proof.error]]);
    const signed = proof.signatures?.length ?? proof.verifierSignatures?.length ?? 0;
    show(output, proof.verdict === "BLOCK" ? "bad" : "ok", [
      ["Verdict", VERDICTS[proof.verdict] ?? proof.verdict],
      ["Signatures", `${signed} (${proof.required} needed)`],
      ["Verifiers", proof.evaluations.map((e) => VERDICTS[e.verdict]).join(", ")],
      ...(proof.digest ? [["Digest", proof.digest, true]] : []),
      ...(proof.attestation ? [["Independent check", `${proof.attestation.status}, by ${proof.attestation.mode}`]] : []),
    ]);
  } catch {
    offline(output);
  }
});

const tokenForm = document.getElementById("token-form");
tokenForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.getElementById("token-result");
  const address = document.getElementById("token-address").value.trim();
  try {
    const response = await fetch(`${API}/v1/tokens/${encodeURIComponent(address)}/check`);
    const body = await response.json();
    if (!response.ok) return show(output, "bad", [["", body.error]]);
    show(
      output,
      body.hazards.length ? "bad" : "ok",
      body.hazards.length
        ? [["Admin functions found", body.hazards.join(", "), true]]
        : [["", "No admin functions found. That doesn't prove a token is safe."]],
    );
  } catch {
    offline(output);
  }
});

const record = document.getElementById("record");
if (record) {
  fetch(`${API}/v1/track-record`)
    .then((r) => r.json())
    .then((data) => {
      const values = [
        (data.verdicts.ALLOW ?? 0) + (data.verdicts.REDUCE ?? 0),
        data.verdicts.BLOCK ?? 0,
        data.verdicts.HUMAN_REQUIRED ?? 0,
        data.attested,
      ];
      record.querySelectorAll("dd").forEach((dd, i) => {
        dd.textContent = String(values[i]);
      });
    })
    .catch(() => {
      document.getElementById("record-note").textContent = "The API isn't reachable from here, so there are no counts to show.";
    });
}
