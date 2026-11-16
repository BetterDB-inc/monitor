import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConnectClusterNodeResponseDto } from '../common/dto/connections.dto';
import { ClusterNodeConnectService } from './cluster-node-connect.service';

@ApiTags('connections')
@Controller('connections')
export class ClusterNodeConnectController {
  constructor(private readonly nodeConnect: ClusterNodeConnectService) {}

  @Post(':id/nodes/:nodeId/connect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connect to one node of a cluster',
    description:
      'Registers a connection for one node of the cluster this connection reads, with the credentials and TLS settings of the cluster connection. The address is taken from the cluster view, never from the request. The node is tested before anything is saved. When a connection already reads the node, that connection is returned and nothing is added.',
  })
  @ApiParam({ name: 'id', description: 'A connection of the cluster' })
  @ApiParam({ name: 'nodeId', description: 'Cluster node id, as CLUSTER NODES reports it' })
  @ApiResponse({ status: 200, description: 'The connection that reads the node', type: ConnectClusterNodeResponseDto })
  @ApiResponse({ status: 400, description: 'The node could not be reached, or this connection cannot dial cluster nodes' })
  @ApiResponse({ status: 404, description: 'Connection not found, or the cluster view does not list the node' })
  @ApiResponse({ status: 409, description: 'The address is registered as a connection that reads another node' })
  async connect(@Param('id') id: string, @Param('nodeId') nodeId: string): Promise<ConnectClusterNodeResponseDto> {
    return this.nodeConnect.connect(id, nodeId);
  }
}
