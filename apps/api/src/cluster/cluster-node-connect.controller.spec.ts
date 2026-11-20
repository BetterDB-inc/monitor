import { ROLES_KEY } from '../auth/guards/roles.decorator';
import { ALLOW_MEMBERS_KEY } from '../auth/guards/roles.decorator';
import { actionFor, targetFor } from '../activity/activity-actions';
import { ClusterNodeConnectController } from './cluster-node-connect.controller';
import { ConnectionsController } from '../connections/connections.controller';

describe('ClusterNodeConnectController', () => {
  it('hands the connection and node of the route to the service', async () => {
    const service = { connect: jest.fn().mockResolvedValue({ id: 'new', created: true }) };
    const controller = new ClusterNodeConnectController(service as never);

    await expect(controller.connect('cluster', 'n2')).resolves.toEqual({ id: 'new', created: true });

    expect(service.connect).toHaveBeenCalledWith('cluster', 'n2');
  });

  it('carries the same guards as creating a connection', () => {
    for (const key of [ROLES_KEY, ALLOW_MEMBERS_KEY]) {
      expect(Reflect.getMetadata(key, ClusterNodeConnectController.prototype.connect)).toEqual(
        Reflect.getMetadata(key, ConnectionsController.prototype.create),
      );
      expect(Reflect.getMetadata(key, ClusterNodeConnectController)).toEqual(
        Reflect.getMetadata(key, ConnectionsController),
      );
    }
  });

  it('is written to the activity log with the connection it returns', () => {
    const action = actionFor('POST', '/connections/:id/nodes/:nodeId/connect');

    expect(action).toBe('connection.connect_node');
    expect(targetFor(action, { id: 'cluster', nodeId: 'n2' }, undefined, { id: 'new', created: true })).toEqual({
      type: 'connection',
      id: 'new',
    });
  });
});
