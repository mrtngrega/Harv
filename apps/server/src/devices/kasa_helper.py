"""Harv's light helper (docs/PLAN.md §6z): drives the user's Tapo lights with python-kasa.

Started by apps/server/src/devices/lights.ts with the venv in ~/.harv/kasa. JSON lines on stdin,
one answer per line on stdout: {"id", "ok", "result"} or {"id", "ok": false, "error", "auth"?}.
The first line is the login ({"op": "login", "email", "password"}); it's never echoed or logged.

Finding lights never logs in: discovery is a broadcast that every Tapo device answers with its
MAC and model. Only a light the user chose is logged in to, so a light on another account (whose
lockout counts every failed login) is never touched.
"""

import asyncio
import json
import sys

from kasa import AuthenticationError, Credentials, Discover, Module

creds: Credentials | None = None
# MAC -> (ip, device) of the lights logged in to.
connected: dict[str, tuple[str, object]] = {}


def mac_of(dev) -> str:
    info = getattr(dev, "_discovery_info", None) or {}
    return str(info.get("result", info).get("mac", "")).replace("-", ":").upper()


def model_of(dev) -> str:
    info = getattr(dev, "_discovery_info", None) or {}
    return str(info.get("result", info).get("device_model", ""))


async def scan(targets: list[str]) -> list[dict]:
    """Every Tapo device answering on these broadcast addresses, without logging in to any."""
    seen: dict[str, dict] = {}
    for target in targets:
        try:
            found = await Discover.discover(target=target, discovery_timeout=3)
        except Exception:  # noqa: BLE001 - one bad interface mustn't hide the others
            continue
        for ip, dev in found.items():
            mac = mac_of(dev)
            if mac and mac not in seen:
                seen[mac] = {"id": mac, "ip": ip, "model": model_of(dev)}
    return list(seen.values())


async def device(mac: str, targets: list[str], ip_hint: str | None):
    """The logged-in device for this MAC: cached, at the hinted address, or found by a scan."""
    if mac in connected:
        return connected[mac][1]
    ip = ip_hint
    if not ip:
        match = next((f for f in await scan(targets) if f["id"] == mac), None)
        if not match:
            raise LookupError("not found on the network (is it powered and on this Wi-Fi?)")
        ip = match["ip"]
    dev = await Discover.discover_single(ip, credentials=creds, discovery_timeout=5)
    if mac_of(dev) and mac_of(dev) != mac:
        await dev.disconnect()
        raise LookupError("another device now has that address")
    connected[mac] = (ip, dev)
    return dev


async def forget(mac: str) -> None:
    if mac in connected:
        try:
            await connected.pop(mac)[1].disconnect()
        except Exception:  # noqa: BLE001
            pass


def state_of(mac: str, ip: str, dev) -> dict:
    light = dev.modules.get(Module.Light)
    effect = dev.modules.get(Module.LightEffect)
    out: dict = {"id": mac, "ip": ip, "name": dev.alias, "model": dev.model, "on": dev.is_on}
    if light:
        out["brightness"] = light.brightness
        if light.has_feature("color_temp"):
            rng = light.valid_temperature_range
            out["tempRange"] = [rng.min, rng.max]
            if light.color_temp:
                out["temp"] = light.color_temp
        if light.has_feature("hsv") and not out.get("temp"):
            hsv = light.hsv
            out["hue"], out["saturation"] = hsv.hue, hsv.saturation
    if effect:
        out["effects"] = [e for e in effect.effect_list if e != "Off"]
        out["effect"] = None if effect.effect in ("Off", None) else effect.effect
    return out


async def read(mac: str, targets: list[str], ip_hint: str | None) -> dict:
    dev = await device(mac, targets, ip_hint)
    await dev.update()
    return state_of(mac, connected[mac][0], dev)


async def change(mac: str, targets: list[str], ip_hint: str | None, c: dict) -> dict:
    dev = await device(mac, targets, ip_hint)
    await dev.update()
    light = dev.modules.get(Module.Light)
    effect = dev.modules.get(Module.LightEffect)
    if c.get("on") is False:
        await dev.turn_off()
    else:
        if "effect" in c and effect:
            await effect.set_effect(c["effect"])
        if "hue" in c and light:
            brightness = int(c.get("brightness", light.brightness or 100))
            await light.set_hsv(int(c["hue"]), int(c.get("saturation", 100)), brightness)
        elif "temp" in c and light:
            await light.set_color_temp(int(c["temp"]))
        if "brightness" in c and light and "hue" not in c:
            await light.set_brightness(int(c["brightness"]))
        if c.get("on") is True or not dev.is_on:
            await dev.turn_on()
    await dev.update()
    return state_of(mac, connected[mac][0], dev)


async def handle(msg: dict) -> dict:
    global creds
    op = msg.get("op")
    if op == "login":
        for mac in list(connected):
            await forget(mac)
        creds = Credentials(msg["email"], msg["password"])
        return {"ok": True, "result": None}
    if op == "scan":
        return {"ok": True, "result": await scan(msg["targets"])}
    if creds is None:
        return {"ok": False, "error": "no login yet"}
    mac = msg["mac"]
    try:
        if op == "state":
            return {"ok": True, "result": await read(mac, msg["targets"], msg.get("ip"))}
        if op == "set":
            return {"ok": True, "result": await change(mac, msg["targets"], msg.get("ip"), msg["change"])}
        return {"ok": False, "error": f"unknown op {op}"}
    except AuthenticationError as ex:
        await forget(mac)
        return {"ok": False, "auth": True, "error": str(ex)}
    except Exception as ex:  # noqa: BLE001 - a dropped connection: the next ask starts over
        await forget(mac)
        return {"ok": False, "error": f"{type(ex).__name__}: {ex}"}


async def main() -> None:
    loop = asyncio.get_running_loop()
    # stdin on a thread: Windows' event loop can't read a pipe from Node directly.
    while line := await loop.run_in_executor(None, sys.stdin.readline):
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        answer = await handle(msg)
        answer["id"] = msg.get("id")
        sys.stdout.write(json.dumps(answer) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
