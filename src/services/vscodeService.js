const VS_CODE_API_URL =
  process.env.VSCODE_AUTOMATION_URL ||
  "https://saturnina-preoceanic-domenica.ngrok-free.dev/execute";

export const openVSCode = async () => {
  const response = await fetch(VS_CODE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      command: "open_vscode",
    }),
  });

  if (!response.ok) {
    throw new Error(`VS Code automation failed with status ${response.status}`);
  }

  return true;
};
