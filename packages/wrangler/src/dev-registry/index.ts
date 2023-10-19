import childProcess from "child_process";
import net from "net";
import events from "events";
import path from "path";
import chalk from "chalk";
import { fetch } from "undici";
import { logger } from "../logger";
import { getBasePath } from "../paths";
import { DEV_REGISTRY_PORT, DEV_REGISTRY_HOST } from "./constants";
import type { Config } from "../config";
import type { WorkerDefinition, WorkerRegistry } from "./constants";

export type { WorkerRegistry } from "./constants";

async function isPortAvailable() {
	return new Promise((resolve, reject) => {
		const netServer = net
			.createServer()
			.once("error", (err) => {
				netServer.close();
				if ((err as unknown as { code: string }).code === "EADDRINUSE") {
					resolve(false);
				} else {
					reject(err);
				}
			})
			.once("listening", () => {
				netServer.close();
				resolve(true);
			});
		netServer.listen(DEV_REGISTRY_PORT);
	});
}

/**
 * Start the service registry. It's a simple server
 * that exposes endpoints for registering and unregistering
 * services, as well as getting the state of the registry.
 */
// TODO(now): don't export this function
// TODO(now): try to only start the daemon once per wrangler instance
export async function startWorkerRegistry() {
	if (await isPortAvailable()) {
		console.log(chalk.cyan("[DEV REGISTRY] Starting server..."));

		const daemonPath = path.join(
			getBasePath(),
			"wrangler-dist",
			"dev-registry",
			"daemon.js"
		);
		const daemonProcess = childProcess.spawn(process.execPath, [daemonPath], {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		daemonProcess.on("exit", (code) => {
			console.log(chalk.cyan(`[DEV REGISTRY] Daemon exited with code ${code}`));
		});
		// TODO(now): type this properly
		const message = (await events.once(daemonProcess, "message")) as any;
		console.log(
			chalk.cyan(`[DEV REGISTRY] Daemon message ${JSON.stringify(message)}`)
		);
		if (message.type === "error") {
			// TODO(now): handle some of these?
			logger.error(message.error);
			return;
		}

		daemonProcess.unref();
	}
}

/**
 * Stop the service registry.
 */
// TODO(now): remove this function
export async function stopWorkerRegistry() {
	console.log(chalk.cyan("[DEV REGISTRY] Stopping server..."));
	// await terminator?.terminate();
	// server = null;
}

/**
 * Register a worker in the registry.
 */
export async function registerWorker(
	name: string,
	definition: WorkerDefinition
) {
	console.log(chalk.green.dim(`[DEV REGISTRY] Registering ${name}...`));
	/**
	 * Prevent the dev registry be closed.
	 */
	await startWorkerRegistry();
	try {
		return await fetch(`${DEV_REGISTRY_HOST}/workers/${name}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(definition),
		});
	} catch (e) {
		if (
			!["ECONNRESET", "ECONNREFUSED"].includes(
				(e as unknown as { cause?: { code?: string } }).cause?.code || "___"
			)
		) {
			logger.error("Failed to register worker in local service registry", e);
		} else {
			logger.debug("Failed to register worker in local service registry", e);
		}
	}
}

/**
 * Unregister a worker from the registry.
 */
// TODO(now): work out why this isn't being called, probably because shutting
//  down synchronously
export async function unregisterWorker(name: string) {
	console.log(chalk.red.dim(`[DEV REGISTRY] Unregistering ${name}...`));
	try {
		await fetch(`${DEV_REGISTRY_HOST}/workers/${name}`, {
			method: "DELETE",
		});
	} catch (e) {
		if (
			!["ECONNRESET", "ECONNREFUSED"].includes(
				(e as unknown as { cause?: { code?: string } }).cause?.code || "___"
			)
		) {
			throw e;
			// logger.error("failed to unregister worker", e);
		}
	}
}

/**
 * Get the state of the service registry.
 */
export async function getRegisteredWorkers(): Promise<
	WorkerRegistry | undefined
> {
	try {
		const response = await fetch(`${DEV_REGISTRY_HOST}/workers`);
		return (await response.json()) as WorkerRegistry;
	} catch (e) {
		if (
			!["ECONNRESET", "ECONNREFUSED"].includes(
				(e as unknown as { cause?: { code?: string } }).cause?.code || "___"
			)
		) {
			throw e;
		}
	}
}

/**
 * a function that takes your serviceNames and durableObjectNames and returns a
 * list of the running workers that we're bound to
 */
export async function getBoundRegisteredWorkers({
	services,
	durableObjects,
}: {
	services: Config["services"] | undefined;
	durableObjects: Config["durable_objects"] | undefined;
}) {
	const serviceNames = (services || []).map(
		(serviceBinding) => serviceBinding.service
	);
	const durableObjectServices = (
		durableObjects || { bindings: [] }
	).bindings.map((durableObjectBinding) => durableObjectBinding.script_name);

	const workerDefinitions = await getRegisteredWorkers();
	const filteredWorkers = Object.fromEntries(
		Object.entries(workerDefinitions || {}).filter(
			([key, _value]) =>
				serviceNames.includes(key) || durableObjectServices.includes(key)
		)
	);
	return filteredWorkers;
}
