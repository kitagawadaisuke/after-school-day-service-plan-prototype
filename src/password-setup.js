const token = new URLSearchParams(window.location.search).get("token");
const requestForm = document.querySelector("#password-request-form");
const setupForm = document.querySelector("#password-setup-form");
const description = document.querySelector("#password-setup-description");
if (token) { requestForm.hidden = true; setupForm.hidden = false; description.textContent = "新しいパスワードを入力してください。8文字以上で設定します。"; }

async function submit(form, url, body, errorId) {
  const error = document.querySelector(errorId); error.hidden = true;
  const button = form.querySelector("button"); button.disabled = true;
  try { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) }); const payload = await response.json().catch(() => null); if (!response.ok) throw new Error(payload?.error?.message || "処理を完了できませんでした。"); return payload; }
  catch (cause) { error.textContent = cause.message; error.hidden = false; button.disabled = false; return null; }
}
requestForm?.addEventListener("submit", async (event) => { event.preventDefault(); const result = await submit(requestForm, "/auth/local/password-setup-requests", { email: requestForm.elements.email.value }, "#password-request-error"); if (result) { description.textContent = result.message; requestForm.hidden = true; } });
setupForm?.addEventListener("submit", async (event) => { event.preventDefault(); if (setupForm.elements.password.value !== setupForm.elements.passwordConfirmation.value) { const error = document.querySelector("#password-setup-error"); error.textContent = "確認用パスワードが一致しません。"; error.hidden = false; return; } const result = await submit(setupForm, "/auth/local/password-setups", { token, password: setupForm.elements.password.value }, "#password-setup-error"); if (result) window.location.assign(result.redirectTo); });
