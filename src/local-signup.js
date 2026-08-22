const form = document.querySelector("#local-signup-form");
const error = document.querySelector("#signup-error");

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  for (const input of form.querySelectorAll("input")) input.setAttribute("aria-invalid", "true");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  for (const input of form.querySelectorAll("input")) input.removeAttribute("aria-invalid");
  const { displayName, email } = form.elements;
  const button = form.querySelector("button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/auth/local/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ displayName: displayName.value, email: email.value }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || "登録を完了できませんでした。");
    form.hidden = true;
    document.querySelector("#signup-description").textContent = payload.message;
  } catch (cause) {
    showError(cause.message);
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
});
