const OWN_CONTROL = new Set(["controllable_by_this_extension", "controlled_by_this_extension"]);
const CONTROLLED = "controlled_by_this_extension";
const WEBRTC_POLICY = "disable_non_proxied_udp";

export function createProxy({ proxy, privacy, extension }) {
  const settings = {
    proxy: proxy.settings,
    prediction: privacy.network.networkPredictionEnabled,
    webrtc: privacy.network.webRTCIPHandlingPolicy,
  };
  const read = async (incognito) => {
    const current = {};
    for (const [name, setting] of Object.entries(settings)) current[name] = await setting.get({ incognito });
    return current;
  };
  const levelsOf = (current) => Object.fromEntries(Object.entries(current).map(([name, { levelOfControl }]) => [name, levelOfControl]));
  const holds = (current, data) => {
    const pac = current.proxy.value?.mode === "pac_script" ? current.proxy.value.pacScript : undefined;
    return (
      Object.values(current).every(({ levelOfControl }) => levelOfControl === CONTROLLED) &&
      pac?.data === data &&
      pac.mandatory === true &&
      current.prediction.value === false &&
      current.webrtc.value === WEBRTC_POLICY
    );
  };
  const control = async (data = null) => {
    const profiles = [await read(false)];
    if (await extension.isAllowedIncognitoAccess()) profiles.push(await read(true));
    const [levels, incognitoLevels = null] = profiles.map(levelsOf);
    return {
      levels,
      incognitoLevels,
      controllable: profiles.every((current) => Object.values(current).every(({ levelOfControl }) => OWN_CONTROL.has(levelOfControl))),
      armed: data !== null && profiles.every((current) => holds(current, data)),
    };
  };
  return {
    control,
    async apply(data) {
      await settings.prediction.set({ scope: "regular", value: false });
      await settings.webrtc.set({ scope: "regular", value: WEBRTC_POLICY });
      await settings.proxy.set({
        scope: "regular",
        value: { mode: "pac_script", pacScript: { data, mandatory: true } },
      });
      return control(data);
    },
    async clear() {
      for (const setting of Object.values(settings)) await setting.clear({ scope: "regular" });
      return control();
    },
  };
}

export function proxyErrorRecord({ error, details, fatal }, time) {
  return { time, error, details, fatal };
}
