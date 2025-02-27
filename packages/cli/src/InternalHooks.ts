import { Service } from 'typedi';
import { snakeCase } from 'change-case';
import type {
	AuthenticationMethod,
	ExecutionStatus,
	INodesGraphResult,
	IRun,
	ITelemetryTrackProperties,
	IWorkflowBase,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import { TelemetryHelpers } from 'n8n-workflow';
import { get as pslGet } from 'psl';
import type {
	IDiagnosticInfo,
	IInternalHooksClass,
	ITelemetryUserDeletionData,
	IWorkflowDb,
	IExecutionTrackProperties,
	IWorkflowExecutionDataProcess,
} from '@/Interfaces';
import { Telemetry } from '@/telemetry';
import type { AuthProviderType } from '@db/entities/AuthIdentity';
import { eventBus } from './eventbus';
import { EventsService } from '@/services/events.service';
import type { User } from '@db/entities/User';
import { N8N_VERSION } from '@/constants';
import { NodeTypes } from './NodeTypes';
import type { ExecutionMetadata } from '@db/entities/ExecutionMetadata';
import { ExecutionRepository } from '@db/repositories';
import { RoleService } from './services/role.service';
import type { EventPayloadWorkflow } from './eventbus/EventMessageClasses/EventMessageWorkflow';
import { determineFinalExecutionStatus } from './executionLifecycleHooks/shared/sharedHookFunctions';
import { InstanceSettings } from 'n8n-core';

function userToPayload(user: User): {
	userId: string;
	_email: string;
	_firstName: string;
	_lastName: string;
	globalRole?: string;
} {
	return {
		userId: user.id,
		_email: user.email,
		_firstName: user.firstName,
		_lastName: user.lastName,
		globalRole: user.globalRole?.name,
	};
}

@Service()
export class InternalHooks implements IInternalHooksClass {
	constructor(
		private telemetry: Telemetry,
		private nodeTypes: NodeTypes,
		private roleService: RoleService,
		private executionRepository: ExecutionRepository,
		eventsService: EventsService,
		private readonly instanceSettings: InstanceSettings,
	) {
		eventsService.on('telemetry.onFirstProductionWorkflowSuccess', async (metrics) =>
			this.onFirstProductionWorkflowSuccess(metrics),
		);
		eventsService.on('telemetry.onFirstWorkflowDataLoad', async (metrics) =>
			this.onFirstWorkflowDataLoad(metrics),
		);
	}

	async init() {
		await this.telemetry.init();
	}

	async onServerStarted(
		diagnosticInfo: IDiagnosticInfo,
		earliestWorkflowCreatedAt?: Date,
	): Promise<unknown[]> {
		const info = {
			version_cli: diagnosticInfo.versionCli,
			db_type: diagnosticInfo.databaseType,
			n8n_version_notifications_enabled: diagnosticInfo.notificationsEnabled,
			n8n_disable_production_main_process: diagnosticInfo.disableProductionWebhooksOnMainProcess,
			system_info: diagnosticInfo.systemInfo,
			execution_variables: diagnosticInfo.executionVariables,
			n8n_deployment_type: diagnosticInfo.deploymentType,
			n8n_binary_data_mode: diagnosticInfo.binaryDataMode,
			smtp_set_up: diagnosticInfo.smtp_set_up,
			ldap_allowed: diagnosticInfo.ldap_allowed,
			saml_enabled: diagnosticInfo.saml_enabled,
			license_plan_name: diagnosticInfo.licensePlanName,
			license_tenant_id: diagnosticInfo.licenseTenantId,
		};

		return Promise.all([
			this.telemetry.identify(info),
			this.telemetry.track('Instance started', {
				...info,
				earliest_workflow_created: earliestWorkflowCreatedAt,
			}),
		]);
	}

	async onFrontendSettingsAPI(sessionId?: string): Promise<void> {
		return this.telemetry.track('Session started', { session_id: sessionId });
	}

	async onPersonalizationSurveySubmitted(
		userId: string,
		answers: Record<string, string>,
	): Promise<void> {
		const camelCaseKeys = Object.keys(answers);
		const personalizationSurveyData = { user_id: userId } as Record<string, string | string[]>;
		camelCaseKeys.forEach((camelCaseKey) => {
			personalizationSurveyData[snakeCase(camelCaseKey)] = answers[camelCaseKey];
		});

		return this.telemetry.track(
			'User responded to personalization questions',
			personalizationSurveyData,
		);
	}

	async onWorkflowCreated(user: User, workflow: IWorkflowBase, publicApi: boolean): Promise<void> {
		const { nodeGraph } = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.workflow.created',
				payload: {
					...userToPayload(user),
					workflowId: workflow.id,
					workflowName: workflow.name,
				},
			}),
			this.telemetry.track('User created workflow', {
				user_id: user.id,
				workflow_id: workflow.id,
				node_graph_string: JSON.stringify(nodeGraph),
				public_api: publicApi,
			}),
		]);
	}

	async onWorkflowDeleted(user: User, workflowId: string, publicApi: boolean): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.workflow.deleted',
				payload: {
					...userToPayload(user),
					workflowId,
				},
			}),
			this.telemetry.track('User deleted workflow', {
				user_id: user.id,
				workflow_id: workflowId,
				public_api: publicApi,
			}),
		]);
	}

	async onWorkflowSaved(user: User, workflow: IWorkflowDb, publicApi: boolean): Promise<void> {
		const { nodeGraph } = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);

		const notesCount = Object.keys(nodeGraph.notes).length;
		const overlappingCount = Object.values(nodeGraph.notes).filter(
			(note) => note.overlapping,
		).length;

		let userRole: 'owner' | 'sharee' | undefined = undefined;
		if (user.id && workflow.id) {
			const role = await this.roleService.findRoleByUserAndWorkflow(user.id, workflow.id);
			if (role) {
				userRole = role.name === 'owner' ? 'owner' : 'sharee';
			}
		}

		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.workflow.updated',
				payload: {
					...userToPayload(user),
					workflowId: workflow.id,
					workflowName: workflow.name,
				},
			}),
			this.telemetry.track('User saved workflow', {
				user_id: user.id,
				workflow_id: workflow.id,
				node_graph_string: JSON.stringify(nodeGraph),
				notes_count_overlapping: overlappingCount,
				notes_count_non_overlapping: notesCount - overlappingCount,
				version_cli: N8N_VERSION,
				num_tags: workflow.tags?.length ?? 0,
				public_api: publicApi,
				sharing_role: userRole,
			}),
		]);
	}

	async onNodeBeforeExecute(
		executionId: string,
		workflow: IWorkflowBase,
		nodeName: string,
	): Promise<void> {
		const nodeInWorkflow = workflow.nodes.find((node) => node.name === nodeName);
		void eventBus.sendNodeEvent({
			eventName: 'n8n.node.started',
			payload: {
				executionId,
				nodeName,
				workflowId: workflow.id?.toString(),
				workflowName: workflow.name,
				nodeType: nodeInWorkflow?.type,
			},
		});
	}

	async onNodePostExecute(
		executionId: string,
		workflow: IWorkflowBase,
		nodeName: string,
	): Promise<void> {
		const nodeInWorkflow = workflow.nodes.find((node) => node.name === nodeName);
		void eventBus.sendNodeEvent({
			eventName: 'n8n.node.finished',
			payload: {
				executionId,
				nodeName,
				workflowId: workflow.id?.toString(),
				workflowName: workflow.name,
				nodeType: nodeInWorkflow?.type,
			},
		});
	}

	async onWorkflowBeforeExecute(
		executionId: string,
		data: IWorkflowExecutionDataProcess | IWorkflowBase,
	): Promise<void> {
		let payload: EventPayloadWorkflow;
		// this hook is called slightly differently depending on whether it's from a worker or the main instance
		// in the worker context, meaning in queue mode, only IWorkflowBase is available
		if ('executionData' in data) {
			payload = {
				executionId,
				userId: data.userId ?? undefined,
				workflowId: data.workflowData.id?.toString(),
				isManual: data.executionMode === 'manual',
				workflowName: data.workflowData.name,
			};
		} else {
			payload = {
				executionId,
				userId: undefined,
				workflowId: (data as IWorkflowBase).id?.toString(),
				isManual: false,
				workflowName: (data as IWorkflowBase).name,
			};
		}
		void Promise.all([
			this.executionRepository.updateExistingExecution(executionId, {
				status: 'running',
			}),
			eventBus.sendWorkflowEvent({
				eventName: 'n8n.workflow.started',
				payload,
			}),
		]);
	}

	async onWorkflowCrashed(
		executionId: string,
		executionMode: WorkflowExecuteMode,
		workflowData?: IWorkflowBase,
		executionMetadata?: ExecutionMetadata[],
	): Promise<void> {
		let metaData;
		try {
			if (executionMetadata) {
				metaData = executionMetadata.reduce((acc, meta) => {
					return { ...acc, [meta.key]: meta.value };
				}, {});
			}
		} catch {}

		void Promise.all([
			eventBus.sendWorkflowEvent({
				eventName: 'n8n.workflow.crashed',
				payload: {
					executionId,
					isManual: executionMode === 'manual',
					workflowId: workflowData?.id?.toString(),
					workflowName: workflowData?.name,
					metaData,
				},
			}),
		]);
	}

	async onWorkflowPostExecute(
		executionId: string,
		workflow: IWorkflowBase,
		runData?: IRun,
		userId?: string,
	): Promise<void> {
		if (!workflow.id) {
			return;
		}

		const promises = [];

		const telemetryProperties: IExecutionTrackProperties = {
			workflow_id: workflow.id,
			is_manual: false,
			version_cli: N8N_VERSION,
			success: false,
		};

		if (userId) {
			telemetryProperties.user_id = userId;
		}

		if (runData?.data.resultData.error?.message?.includes('canceled')) {
			runData.status = 'canceled';
		}

		telemetryProperties.success = !!runData?.finished;

		// const executionStatus: ExecutionStatus = runData?.status ?? 'unknown';
		const executionStatus: ExecutionStatus = runData
			? determineFinalExecutionStatus(runData)
			: 'unknown';

		if (runData !== undefined) {
			telemetryProperties.execution_mode = runData.mode;
			telemetryProperties.is_manual = runData.mode === 'manual';

			let nodeGraphResult: INodesGraphResult | null = null;

			if (!telemetryProperties.success && runData?.data.resultData.error) {
				telemetryProperties.error_message = runData?.data.resultData.error.message;
				let errorNodeName =
					'node' in runData?.data.resultData.error
						? runData?.data.resultData.error.node?.name
						: undefined;
				telemetryProperties.error_node_type =
					'node' in runData?.data.resultData.error
						? runData?.data.resultData.error.node?.type
						: undefined;

				if (runData.data.resultData.lastNodeExecuted) {
					const lastNode = TelemetryHelpers.getNodeTypeForName(
						workflow,
						runData.data.resultData.lastNodeExecuted,
					);

					if (lastNode !== undefined) {
						telemetryProperties.error_node_type = lastNode.type;
						errorNodeName = lastNode.name;
					}
				}

				if (telemetryProperties.is_manual) {
					nodeGraphResult = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);
					telemetryProperties.node_graph = nodeGraphResult.nodeGraph;
					telemetryProperties.node_graph_string = JSON.stringify(nodeGraphResult.nodeGraph);

					if (errorNodeName) {
						telemetryProperties.error_node_id = nodeGraphResult.nameIndices[errorNodeName];
					}
				}
			}

			if (telemetryProperties.is_manual) {
				if (!nodeGraphResult) {
					nodeGraphResult = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);
				}

				let userRole: 'owner' | 'sharee' | undefined = undefined;
				if (userId) {
					const role = await this.roleService.findRoleByUserAndWorkflow(userId, workflow.id);
					if (role) {
						userRole = role.name === 'owner' ? 'owner' : 'sharee';
					}
				}

				const manualExecEventProperties: ITelemetryTrackProperties = {
					user_id: userId,
					workflow_id: workflow.id,
					status: executionStatus,
					executionStatus: runData?.status ?? 'unknown',
					error_message: telemetryProperties.error_message as string,
					error_node_type: telemetryProperties.error_node_type,
					node_graph_string: telemetryProperties.node_graph_string as string,
					error_node_id: telemetryProperties.error_node_id as string,
					webhook_domain: null,
					sharing_role: userRole,
				};

				if (!manualExecEventProperties.node_graph_string) {
					nodeGraphResult = TelemetryHelpers.generateNodesGraph(workflow, this.nodeTypes);
					manualExecEventProperties.node_graph_string = JSON.stringify(nodeGraphResult.nodeGraph);
				}

				if (runData.data.startData?.destinationNode) {
					const telemetryPayload = {
						...manualExecEventProperties,
						node_type: TelemetryHelpers.getNodeTypeForName(
							workflow,
							runData.data.startData?.destinationNode,
						)?.type,
						node_id: nodeGraphResult.nameIndices[runData.data.startData?.destinationNode],
					};

					promises.push(this.telemetry.track('Manual node exec finished', telemetryPayload));
				} else {
					nodeGraphResult.webhookNodeNames.forEach((name: string) => {
						const execJson = runData.data.resultData.runData[name]?.[0]?.data?.main?.[0]?.[0]
							?.json as { headers?: { origin?: string } };
						if (execJson?.headers?.origin && execJson.headers.origin !== '') {
							manualExecEventProperties.webhook_domain = pslGet(
								execJson.headers.origin.replace(/^https?:\/\//, ''),
							);
						}
					});

					promises.push(
						this.telemetry.track('Manual workflow exec finished', manualExecEventProperties),
					);
				}
			}
		}

		const sharedEventPayload: EventPayloadWorkflow = {
			executionId,
			success: telemetryProperties.success,
			userId: telemetryProperties.user_id,
			workflowId: workflow.id,
			isManual: telemetryProperties.is_manual,
			workflowName: workflow.name,
			metaData: runData?.data?.resultData?.metadata,
		};
		promises.push(
			telemetryProperties.success
				? eventBus.sendWorkflowEvent({
						eventName: 'n8n.workflow.success',
						payload: sharedEventPayload,
				  })
				: eventBus.sendWorkflowEvent({
						eventName: 'n8n.workflow.failed',
						payload: {
							...sharedEventPayload,
							lastNodeExecuted: runData?.data.resultData.lastNodeExecuted,
							errorNodeType: telemetryProperties.error_node_type,
							errorNodeId: telemetryProperties.error_node_id?.toString(),
							errorMessage: telemetryProperties.error_message?.toString(),
						},
				  }),
		);

		void Promise.all([...promises, this.telemetry.trackWorkflowExecution(telemetryProperties)]);
	}

	async onWorkflowSharingUpdate(workflowId: string, userId: string, userList: string[]) {
		const properties: ITelemetryTrackProperties = {
			workflow_id: workflowId,
			user_id_sharer: userId,
			user_id_list: userList,
		};

		return this.telemetry.track('User updated workflow sharing', properties);
	}

	async onN8nStop(): Promise<void> {
		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				resolve();
			}, 3000);
		});

		return Promise.race([timeoutPromise, this.telemetry.trackN8nStop()]);
	}

	async onUserDeletion(userDeletionData: {
		user: User;
		telemetryData: ITelemetryUserDeletionData;
		publicApi: boolean;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.deleted',
				payload: {
					...userToPayload(userDeletionData.user),
				},
			}),
			this.telemetry.track('User deleted user', {
				...userDeletionData.telemetryData,
				user_id: userDeletionData.user.id,
				public_api: userDeletionData.publicApi,
			}),
		]);
	}

	async onUserInvite(userInviteData: {
		user: User;
		target_user_id: string[];
		public_api: boolean;
		email_sent: boolean;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.invited',
				payload: {
					...userToPayload(userInviteData.user),
					targetUserId: userInviteData.target_user_id,
				},
			}),
			this.telemetry.track('User invited new user', {
				user_id: userInviteData.user.id,
				target_user_id: userInviteData.target_user_id,
				public_api: userInviteData.public_api,
				email_sent: userInviteData.email_sent,
			}),
		]);
	}

	async onUserReinvite(userReinviteData: {
		user: User;
		target_user_id: string;
		public_api: boolean;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.reinvited',
				payload: {
					...userToPayload(userReinviteData.user),
					targetUserId: userReinviteData.target_user_id,
				},
			}),
			this.telemetry.track('User resent new user invite email', {
				user_id: userReinviteData.user.id,
				target_user_id: userReinviteData.target_user_id,
				public_api: userReinviteData.public_api,
			}),
		]);
	}

	async onUserRetrievedUser(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return this.telemetry.track('User retrieved user', userRetrievedData);
	}

	async onUserRetrievedAllUsers(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return this.telemetry.track('User retrieved all users', userRetrievedData);
	}

	async onUserRetrievedExecution(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return this.telemetry.track('User retrieved execution', userRetrievedData);
	}

	async onUserRetrievedAllExecutions(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return this.telemetry.track('User retrieved all executions', userRetrievedData);
	}

	async onUserRetrievedWorkflow(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return this.telemetry.track('User retrieved workflow', userRetrievedData);
	}

	async onUserRetrievedAllWorkflows(userRetrievedData: {
		user_id: string;
		public_api: boolean;
	}): Promise<void> {
		return this.telemetry.track('User retrieved all workflows', userRetrievedData);
	}

	async onUserUpdate(userUpdateData: { user: User; fields_changed: string[] }): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.updated',
				payload: {
					...userToPayload(userUpdateData.user),
					fieldsChanged: userUpdateData.fields_changed,
				},
			}),
			this.telemetry.track('User changed personal settings', {
				user_id: userUpdateData.user.id,
				fields_changed: userUpdateData.fields_changed,
			}),
		]);
	}

	async onUserInviteEmailClick(userInviteClickData: {
		inviter: User;
		invitee: User;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.invitation.accepted',
				payload: {
					invitee: {
						...userToPayload(userInviteClickData.invitee),
					},
					inviter: {
						...userToPayload(userInviteClickData.inviter),
					},
				},
			}),
			this.telemetry.track('User clicked invite link from email', {
				user_id: userInviteClickData.invitee.id,
			}),
		]);
	}

	async onUserPasswordResetEmailClick(userPasswordResetData: { user: User }): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.reset',
				payload: {
					...userToPayload(userPasswordResetData.user),
				},
			}),
			this.telemetry.track('User clicked password reset link from email', {
				user_id: userPasswordResetData.user.id,
			}),
		]);
	}

	async onUserTransactionalEmail(userTransactionalEmailData: {
		user_id: string;
		message_type: 'Reset password' | 'New user invite' | 'Resend invite';
		public_api: boolean;
	}): Promise<void> {
		return this.telemetry.track(
			'Instance sent transactional email to user',
			userTransactionalEmailData,
		);
	}

	async onUserInvokedApi(userInvokedApiData: {
		user_id: string;
		path: string;
		method: string;
		api_version: string;
	}): Promise<void> {
		return this.telemetry.track('User invoked API', userInvokedApiData);
	}

	async onApiKeyDeleted(apiKeyDeletedData: { user: User; public_api: boolean }): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.api.deleted',
				payload: {
					...userToPayload(apiKeyDeletedData.user),
				},
			}),
			this.telemetry.track('API key deleted', {
				user_id: apiKeyDeletedData.user.id,
				public_api: apiKeyDeletedData.public_api,
			}),
		]);
	}

	async onApiKeyCreated(apiKeyCreatedData: { user: User; public_api: boolean }): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.api.created',
				payload: {
					...userToPayload(apiKeyCreatedData.user),
				},
			}),
			this.telemetry.track('API key created', {
				user_id: apiKeyCreatedData.user.id,
				public_api: apiKeyCreatedData.public_api,
			}),
		]);
	}

	async onUserPasswordResetRequestClick(userPasswordResetData: { user: User }): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.reset.requested',
				payload: {
					...userToPayload(userPasswordResetData.user),
				},
			}),
			this.telemetry.track('User requested password reset while logged out', {
				user_id: userPasswordResetData.user.id,
			}),
		]);
	}

	async onInstanceOwnerSetup(instanceOwnerSetupData: { user_id: string }): Promise<void> {
		return this.telemetry.track('Owner finished instance setup', instanceOwnerSetupData);
	}

	async onUserSignup(
		user: User,
		userSignupData: {
			user_type: AuthProviderType;
			was_disabled_ldap_user: boolean;
		},
	): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.signedup',
				payload: {
					...userToPayload(user),
				},
			}),
			this.telemetry.track('User signed up', {
				user_id: user.id,
				...userSignupData,
			}),
		]);
	}

	async onEmailFailed(failedEmailData: {
		user: User;
		message_type: 'Reset password' | 'New user invite' | 'Resend invite';
		public_api: boolean;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.email.failed',
				payload: {
					messageType: failedEmailData.message_type,
					...userToPayload(failedEmailData.user),
				},
			}),
			this.telemetry.track('Instance failed to send transactional email to user', {
				user_id: failedEmailData.user.id,
			}),
		]);
	}

	async onUserLoginSuccess(userLoginData: {
		user: User;
		authenticationMethod: AuthenticationMethod;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.login.success',
				payload: {
					authenticationMethod: userLoginData.authenticationMethod,
					...userToPayload(userLoginData.user),
				},
			}),
		]);
	}

	async onUserLoginFailed(userLoginData: {
		user: string;
		authenticationMethod: AuthenticationMethod;
		reason?: string;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.login.failed',
				payload: {
					authenticationMethod: userLoginData.authenticationMethod,
					user: userLoginData.user,
					reason: userLoginData.reason,
				},
			}),
		]);
	}

	/**
	 * Credentials
	 */

	async onUserCreatedCredentials(userCreatedCredentialsData: {
		user: User;
		credential_name: string;
		credential_type: string;
		credential_id: string;
		public_api: boolean;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.credentials.created',
				payload: {
					...userToPayload(userCreatedCredentialsData.user),
					credentialName: userCreatedCredentialsData.credential_name,
					credentialType: userCreatedCredentialsData.credential_type,
					credentialId: userCreatedCredentialsData.credential_id,
				},
			}),
			this.telemetry.track('User created credentials', {
				user_id: userCreatedCredentialsData.user.id,
				credential_type: userCreatedCredentialsData.credential_type,
				credential_id: userCreatedCredentialsData.credential_id,
				instance_id: this.instanceSettings.instanceId,
			}),
		]);
	}

	async onUserSharedCredentials(userSharedCredentialsData: {
		user: User;
		credential_name: string;
		credential_type: string;
		credential_id: string;
		user_id_sharer: string;
		user_ids_sharees_added: string[];
		sharees_removed: number | null;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.user.credentials.shared',
				payload: {
					...userToPayload(userSharedCredentialsData.user),
					credentialName: userSharedCredentialsData.credential_name,
					credentialType: userSharedCredentialsData.credential_type,
					credentialId: userSharedCredentialsData.credential_id,
					userIdSharer: userSharedCredentialsData.user_id_sharer,
					userIdsShareesAdded: userSharedCredentialsData.user_ids_sharees_added,
					shareesRemoved: userSharedCredentialsData.sharees_removed,
				},
			}),
			this.telemetry.track('User updated cred sharing', {
				user_id: userSharedCredentialsData.user.id,
				credential_type: userSharedCredentialsData.credential_type,
				credential_id: userSharedCredentialsData.credential_id,
				user_id_sharer: userSharedCredentialsData.user_id_sharer,
				user_ids_sharees_added: userSharedCredentialsData.user_ids_sharees_added,
				sharees_removed: userSharedCredentialsData.sharees_removed,
				instance_id: this.instanceSettings.instanceId,
			}),
		]);
	}

	/**
	 * Community nodes backend telemetry events
	 */

	async onCommunityPackageInstallFinished(installationData: {
		user: User;
		input_string: string;
		package_name: string;
		success: boolean;
		package_version?: string;
		package_node_names?: string[];
		package_author?: string;
		package_author_email?: string;
		failure_reason?: string;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.package.installed',
				payload: {
					...userToPayload(installationData.user),
					inputString: installationData.input_string,
					packageName: installationData.package_name,
					success: installationData.success,
					packageVersion: installationData.package_version,
					packageNodeNames: installationData.package_node_names,
					packageAuthor: installationData.package_author,
					packageAuthorEmail: installationData.package_author_email,
					failureReason: installationData.failure_reason,
				},
			}),
			this.telemetry.track('cnr package install finished', {
				user_id: installationData.user.id,
				input_string: installationData.input_string,
				package_name: installationData.package_name,
				success: installationData.success,
				package_version: installationData.package_version,
				package_node_names: installationData.package_node_names,
				package_author: installationData.package_author,
				package_author_email: installationData.package_author_email,
				failure_reason: installationData.failure_reason,
			}),
		]);
	}

	async onCommunityPackageUpdateFinished(updateData: {
		user: User;
		package_name: string;
		package_version_current: string;
		package_version_new: string;
		package_node_names: string[];
		package_author?: string;
		package_author_email?: string;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.package.updated',
				payload: {
					...userToPayload(updateData.user),
					packageName: updateData.package_name,
					packageVersionCurrent: updateData.package_version_current,
					packageVersionNew: updateData.package_version_new,
					packageNodeNames: updateData.package_node_names,
					packageAuthor: updateData.package_author,
					packageAuthorEmail: updateData.package_author_email,
				},
			}),
			this.telemetry.track('cnr package updated', {
				user_id: updateData.user.id,
				package_name: updateData.package_name,
				package_version_current: updateData.package_version_current,
				package_version_new: updateData.package_version_new,
				package_node_names: updateData.package_node_names,
				package_author: updateData.package_author,
				package_author_email: updateData.package_author_email,
			}),
		]);
	}

	async onCommunityPackageDeleteFinished(deleteData: {
		user: User;
		package_name: string;
		package_version: string;
		package_node_names: string[];
		package_author?: string;
		package_author_email?: string;
	}): Promise<void> {
		void Promise.all([
			eventBus.sendAuditEvent({
				eventName: 'n8n.audit.package.deleted',
				payload: {
					...userToPayload(deleteData.user),
					packageName: deleteData.package_name,
					packageVersion: deleteData.package_version,
					packageNodeNames: deleteData.package_node_names,
					packageAuthor: deleteData.package_author,
					packageAuthorEmail: deleteData.package_author_email,
				},
			}),
			this.telemetry.track('cnr package deleted', {
				user_id: deleteData.user.id,
				package_name: deleteData.package_name,
				package_version: deleteData.package_version,
				package_node_names: deleteData.package_node_names,
				package_author: deleteData.package_author,
				package_author_email: deleteData.package_author_email,
			}),
		]);
	}

	async onLdapSyncFinished(data: {
		type: string;
		succeeded: boolean;
		users_synced: number;
		error: string;
	}): Promise<void> {
		return this.telemetry.track('Ldap general sync finished', data);
	}

	async onUserUpdatedLdapSettings(data: {
		user_id: string;
		loginIdAttribute: string;
		firstNameAttribute: string;
		lastNameAttribute: string;
		emailAttribute: string;
		ldapIdAttribute: string;
		searchPageSize: number;
		searchTimeout: number;
		synchronizationEnabled: boolean;
		synchronizationInterval: number;
		loginLabel: string;
		loginEnabled: boolean;
	}): Promise<void> {
		return this.telemetry.track('Ldap general sync finished', data);
	}

	async onLdapLoginSyncFailed(data: { error: string }): Promise<void> {
		return this.telemetry.track('Ldap login sync failed', data);
	}

	async userLoginFailedDueToLdapDisabled(data: { user_id: string }): Promise<void> {
		return this.telemetry.track('User login failed since ldap disabled', data);
	}

	/*
	 * Execution Statistics
	 */
	async onFirstProductionWorkflowSuccess(data: {
		user_id: string;
		workflow_id: string;
	}): Promise<void> {
		return this.telemetry.track('Workflow first prod success', data);
	}

	async onFirstWorkflowDataLoad(data: {
		user_id: string;
		workflow_id: string;
		node_type: string;
		node_id: string;
		credential_type?: string;
		credential_id?: string;
	}): Promise<void> {
		return this.telemetry.track('Workflow first data fetched', data);
	}

	/**
	 * License
	 */
	async onLicenseRenewAttempt(data: { success: boolean }): Promise<void> {
		await this.telemetry.track('Instance attempted to refresh license', data);
	}

	/**
	 * Audit
	 */
	async onAuditGeneratedViaCli() {
		return this.telemetry.track('Instance generated security audit via CLI command');
	}

	async onVariableCreated(createData: { variable_type: string }): Promise<void> {
		return this.telemetry.track('User created variable', createData);
	}

	async onSourceControlSettingsUpdated(data: {
		branch_name: string;
		read_only_instance: boolean;
		repo_type: 'github' | 'gitlab' | 'other';
		connected: boolean;
	}): Promise<void> {
		return this.telemetry.track('User updated source control settings', data);
	}

	async onSourceControlUserStartedPullUI(data: {
		workflow_updates: number;
		workflow_conflicts: number;
		cred_conflicts: number;
	}): Promise<void> {
		return this.telemetry.track('User started pull via UI', data);
	}

	async onSourceControlUserFinishedPullUI(data: { workflow_updates: number }): Promise<void> {
		return this.telemetry.track('User finished pull via UI', {
			workflow_updates: data.workflow_updates,
		});
	}

	async onSourceControlUserPulledAPI(data: {
		workflow_updates: number;
		forced: boolean;
	}): Promise<void> {
		return this.telemetry.track('User pulled via API', data);
	}

	async onSourceControlUserStartedPushUI(data: {
		workflows_eligible: number;
		workflows_eligible_with_conflicts: number;
		creds_eligible: number;
		creds_eligible_with_conflicts: number;
		variables_eligible: number;
	}): Promise<void> {
		return this.telemetry.track('User started push via UI', data);
	}

	async onSourceControlUserFinishedPushUI(data: {
		workflows_eligible: number;
		workflows_pushed: number;
		creds_pushed: number;
		variables_pushed: number;
	}): Promise<void> {
		return this.telemetry.track('User finished push via UI', data);
	}

	async onExternalSecretsProviderSettingsSaved(saveData: {
		user_id?: string | undefined;
		vault_type: string;
		is_valid: boolean;
		is_new: boolean;
		error_message?: string | undefined;
	}): Promise<void> {
		return this.telemetry.track('User updated external secrets settings', saveData);
	}
}
