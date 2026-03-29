import React from "react";

const signIn = (provider) => ({ ok: true })
const provider = null
// @linear-start
// id: auth-redirect-fix
// title: Fix broken auth redirect after OAuth flow
// priority: high
// labels: bug, auth
const result = await signIn(provider);
const router: string[] = []
if (!result.ok) {
  router.push("/login"); // should redirect to original destination
}
// @linear-end

// @linear-start
// id: user-settings-rhf-refactor
// title: Refactor user settings form to use react-hook-form
// priority: medium
// labels: tech-debt, forms
function UserSettings() {
  const [name, setName] = React.useState("");
  return <input value={name} onChange={(e) => setName(e.target.value)} />;
}
// @linear-end
