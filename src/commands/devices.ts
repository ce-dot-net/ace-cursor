/**
 * ACE Device Management Commands
 * Provides UI for managing registered devices (list, rename, remove)
 * Uses @ace-sdk/core device management functions
 */

import * as vscode from 'vscode';
import {
	listDevices,
	renameDevice,
	removeDevice,
	getDeviceLimit
} from '@ace-sdk/core';
import type { Device } from '@ace-sdk/core';
import { getValidToken } from './login';

/**
 * Format device for display in QuickPick
 */
function formatDeviceLabel(device: Device): string {
	const current = device.is_current ? ' $(check) (current)' : '';
	const name = device.device_name || device.device_id.slice(0, 8);
	return `$(device-desktop) ${name}${current}`;
}

/**
 * Format device detail for QuickPick
 */
function formatDeviceDetail(device: Device): string {
	const lastSeen = device.last_seen_at
		? `Last seen: ${new Date(device.last_seen_at).toLocaleDateString()}`
		: 'Never used';
	const firstSeen = device.first_seen_at
		? `First seen: ${new Date(device.first_seen_at).toLocaleDateString()}`
		: '';
	const clients = device.clients.length > 0
		? `Clients: ${device.clients.join(', ')}`
		: '';
	return [lastSeen, firstSeen, clients].filter(Boolean).join(' | ');
}

/**
 * Show device management QuickPick
 * Lists all devices with options to rename or remove
 */
export async function showDevicesQuickPick(): Promise<void> {
	// Ensure we have a valid token
	const tokenResult = await getValidToken();
	if (!tokenResult) {
		const action = await vscode.window.showWarningMessage(
			'ACE login required to manage devices.',
			'Login'
		);
		if (action === 'Login') {
			vscode.commands.executeCommand('ace.login');
		}
		return;
	}

	try {
		// Show loading
		const result = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Loading devices...',
			cancellable: false
		}, async () => {
			const [deviceList, limit] = await Promise.all([
				listDevices(),
				getDeviceLimit()
			]);
			return { devices: deviceList, limit };
		});

		if (!result.devices || result.devices.length === 0) {
			vscode.window.showInformationMessage('No devices registered.');
			return;
		}

		// Build QuickPick items
		const items: (vscode.QuickPickItem & { device?: Device; action?: string })[] = [
			{
				label: `$(info) Device Limit: ${result.devices.length}/${result.limit.max_devices}`,
				description: 'Current device usage',
				kind: vscode.QuickPickItemKind.Separator
			}
		];

		for (const device of result.devices) {
			items.push({
				label: formatDeviceLabel(device),
				description: device.device_id.slice(0, 12) + '...',
				detail: formatDeviceDetail(device),
				device
			});
		}

		// Add separator and actions
		items.push({
			label: '',
			kind: vscode.QuickPickItemKind.Separator
		});
		items.push({
			label: '$(refresh) Refresh List',
			action: 'refresh'
		});

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a device to manage',
			title: 'ACE Device Management'
		});

		if (!selected) return;

		if (selected.action === 'refresh') {
			// Recursive call to refresh
			return showDevicesQuickPick();
		}

		if (selected.device) {
			// Show device actions
			await showDeviceActions(selected.device);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to load devices: ${message}`);
	}
}

/**
 * Show actions for a specific device
 */
async function showDeviceActions(device: Device): Promise<void> {
	const deviceName = device.device_name || device.device_id.slice(0, 8);
	const isCurrent = device.is_current;

	const actionItems: { label: string; description: string; action: string }[] = [
		{
			label: '$(edit) Rename Device',
			description: `Change the name of "${deviceName}"`,
			action: 'rename'
		}
	];

	// Only allow removing non-current devices
	if (!isCurrent) {
		actionItems.push({
			label: '$(trash) Remove Device',
			description: 'Revoke access for this device',
			action: 'remove'
		});
	} else {
		actionItems.push({
			label: '$(warning) Cannot Remove Current Device',
			description: 'You cannot remove the device you are currently using',
			action: 'none'
		});
	}

	actionItems.push({
		label: '$(arrow-left) Back to List',
		description: '',
		action: 'back'
	});

	const action = await vscode.window.showQuickPick(actionItems, {
		placeHolder: `Actions for "${deviceName}"`,
		title: 'Device Actions'
	});

	if (!action) return;

	switch (action.action) {
		case 'rename':
			await renameDevicePrompt(device);
			break;
		case 'remove':
			await removeDevicePrompt(device);
			break;
		case 'back':
			await showDevicesQuickPick();
			break;
	}
}

/**
 * Prompt to rename a device
 */
async function renameDevicePrompt(device: Device): Promise<void> {
	const currentName = device.device_name || device.device_id.slice(0, 8);

	const newName = await vscode.window.showInputBox({
		prompt: 'Enter new device name',
		value: currentName,
		validateInput: (value) => {
			if (!value || value.trim().length === 0) {
				return 'Device name cannot be empty';
			}
			if (value.length > 50) {
				return 'Device name must be 50 characters or less';
			}
			return null;
		}
	});

	if (!newName || newName === currentName) return;

	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Renaming device...',
			cancellable: false
		}, async () => {
			await renameDevice(device.device_id, newName.trim());
		});

		vscode.window.showInformationMessage(`Device renamed to "${newName}"`);
		// Refresh list
		await showDevicesQuickPick();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to rename device: ${message}`);
	}
}

/**
 * Prompt to remove a device
 */
async function removeDevicePrompt(device: Device): Promise<void> {
	const deviceName = device.device_name || device.device_id.slice(0, 8);

	const confirm = await vscode.window.showWarningMessage(
		`Remove device "${deviceName}"? This will revoke its access to ACE.`,
		{ modal: true },
		'Remove'
	);

	if (confirm !== 'Remove') return;

	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Removing device...',
			cancellable: false
		}, async () => {
			await removeDevice(device.device_id);
		});

		vscode.window.showInformationMessage(`Device "${deviceName}" has been removed.`);
		// Refresh list
		await showDevicesQuickPick();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to remove device: ${message}`);
	}
}
