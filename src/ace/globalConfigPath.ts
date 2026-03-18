import * as os from 'os';
import * as path from 'path';

/**
 * Global ACE config path.
 *
 * This repo's extension uses an on-disk config file for auth + connection details.
 * Per request, the default location is ephemeral under /tmp (not inside the extension,
 * and not in the user's home directory).
 *
 * Can be overridden via ACE_CONFIG_PATH.
 */
export function getAceGlobalConfigPath(): string {
	const override = process.env.ACE_CONFIG_PATH?.trim();
	if (override) return override;

	// Prefer an explicit /tmp path on Unix-like systems.
	if (process.platform !== 'win32') {
		return path.join('/tmp', 'ace', 'config.json');
	}

	// Windows: fall back to OS temp directory.
	return path.join(os.tmpdir(), 'ace', 'config.json');
}

export function getAceGlobalConfigDir(): string {
	return path.dirname(getAceGlobalConfigPath());
}
