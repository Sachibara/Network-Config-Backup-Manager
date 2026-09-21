window.CONFIG_BACKUP_DEMO = (() => {
  const now = Date.now();
  const ago = (hours) => new Date(now - hours * 3600000).toISOString();

  const devices = [
    {id:1,hostname:"CORE-RTR-01",ip:"192.168.10.1",role:"Core Router",site:"HQ",platform:"cisco_ios",platform_label:"Cisco IOS XE",tags:["core","wan"],interval_minutes:360,retention:20,last_backup_at:ago(.4),last_status:"success"},
    {id:2,hostname:"CORE-SW-01",ip:"192.168.10.2",role:"Core Switch",site:"HQ",platform:"cisco_ios",platform_label:"Cisco IOS XE",tags:["core","campus"],interval_minutes:360,retention:20,last_backup_at:ago(.8),last_status:"success"},
    {id:3,hostname:"DIST-SW-F2",ip:"192.168.20.2",role:"Distribution Switch",site:"HQ",platform:"cisco_ios",platform_label:"Cisco IOS XE",tags:["distribution","floor2"],interval_minutes:720,retention:15,last_backup_at:ago(2.1),last_status:"success"},
    {id:4,hostname:"EDGE-RTR-01",ip:"10.20.0.1",role:"Edge Router",site:"Branch",platform:"cisco_ios",platform_label:"Cisco IOS",tags:["edge","branch"],interval_minutes:720,retention:15,last_backup_at:ago(5.4),last_status:"success"},
    {id:5,hostname:"BR-SW-01",ip:"10.20.0.2",role:"Access Switch",site:"Branch",platform:"cisco_ios",platform_label:"Cisco IOS",tags:["access","branch"],interval_minutes:1440,retention:10,last_backup_at:ago(25),last_status:"failed"},
    {id:6,hostname:"DC-NX-01",ip:"172.16.10.10",role:"Datacenter Switch",site:"Datacenter",platform:"cisco_nxos",platform_label:"Cisco NX-OS",tags:["dc","core"],interval_minutes:360,retention:30,last_backup_at:ago(1.2),last_status:"success"}
  ];

  const configs = {
    r1v1:`version 17.9
hostname CORE-RTR-01
!
interface GigabitEthernet0/0
 description WAN-UPLINK
 ip address 203.0.113.2 255.255.255.252
 no shutdown
!
interface GigabitEthernet0/1
 description LAN-CORE
 ip address 192.168.10.1 255.255.255.0
 no shutdown
!
router ospf 10
 router-id 10.10.10.1
 network 192.168.10.0 0.0.0.255 area 0
!
ip route 0.0.0.0 0.0.0.0 203.0.113.1
!
line vty 0 4
 transport input ssh
 login local
!`,
    r1v2:`version 17.9
hostname CORE-RTR-01
!
interface GigabitEthernet0/0
 description WAN-UPLINK
 ip address 203.0.113.2 255.255.255.252
 no shutdown
!
interface GigabitEthernet0/1
 description LAN-CORE
 ip address 192.168.10.1 255.255.255.0
 no shutdown
!
interface GigabitEthernet0/2
 description MGMT-NET
 ip address 192.168.99.1 255.255.255.0
 no shutdown
!
router ospf 10
 router-id 10.10.10.1
 network 192.168.10.0 0.0.0.255 area 0
 network 192.168.99.0 0.0.0.255 area 0
!
ip route 0.0.0.0 0.0.0.0 203.0.113.1
!
line vty 0 4
 transport input ssh
 login local
!`,
    s1v1:`version 17.6
hostname CORE-SW-01
!
vlan 10
 name USERS
vlan 20
 name VOICE
vlan 30
 name SERVERS
!
interface GigabitEthernet1/0/1
 description UPLINK-CORE-RTR
 switchport mode trunk
!
interface Vlan10
 ip address 192.168.10.2 255.255.255.0
 no shutdown
!
spanning-tree mode rapid-pvst
!`,
    s1v2:`version 17.6
hostname CORE-SW-01
!
vlan 10
 name USERS
vlan 20
 name VOICE
vlan 30
 name SERVERS
vlan 40
 name WIFI-CORP
!
interface GigabitEthernet1/0/1
 description UPLINK-CORE-RTR
 switchport mode trunk
 switchport trunk allowed vlan 10,20,30,40
!
interface Vlan10
 ip address 192.168.10.2 255.255.255.0
 no shutdown
!
spanning-tree mode rapid-pvst
!`,
    d1v1:`version 16.12
hostname DIST-SW-F2
!
vlan 10
 name USERS
vlan 40
 name WIFI-CORP
!
interface GigabitEthernet1/0/48
 description UPLINK-CORE
 switchport mode trunk
!
interface range GigabitEthernet1/0/1-24
 switchport access vlan 10
 spanning-tree portfast
!
line vty 0 4
 transport input ssh
!`,
    edge1:`version 15.7
hostname EDGE-RTR-01
!
interface GigabitEthernet0/0
 description BRANCH-WAN
 ip address 198.51.100.10 255.255.255.252
!
interface GigabitEthernet0/1
 description BRANCH-LAN
 ip address 10.20.0.1 255.255.255.0
!
ip route 0.0.0.0 0.0.0.0 198.51.100.9
!
line vty 0 4
 transport input ssh
!`,
    branch1:`version 15.2
hostname BR-SW-01
!
vlan 10
 name BRANCH-USERS
!
interface GigabitEthernet0/1
 description UPLINK-EDGE
 switchport mode trunk
!
interface range GigabitEthernet0/2-24
 switchport access vlan 10
 spanning-tree portfast
!`,
    nx1:`version 9.3(10)
hostname DC-NX-01
feature interface-vlan
feature lacp
!
vlan 100
 name SERVERS
vlan 110
 name STORAGE
!
interface Ethernet1/1
 description UPLINK-CORE
 switchport mode trunk
 no shutdown
!
interface port-channel10
 description SERVER-LAG
 switchport mode trunk
!`
  };

  const backups = [
    {id:101,device_id:1,device:"CORE-RTR-01",version:3,source:"running-config",status:"success",changed:true,hash:"9f2b1a4e8d1c",size:812,created_at:ago(.4),config:configs.r1v2},
    {id:100,device_id:1,device:"CORE-RTR-01",version:2,source:"running-config",status:"success",changed:false,hash:"5d17e3c98ab0",size:654,created_at:ago(6.5),config:configs.r1v1},
    {id:99,device_id:1,device:"CORE-RTR-01",version:1,source:"startup-config",status:"success",changed:false,hash:"5d17e3c98ab0",size:654,created_at:ago(30),config:configs.r1v1},
    {id:201,device_id:2,device:"CORE-SW-01",version:4,source:"running-config",status:"success",changed:true,hash:"3e71a9f4c120",size:701,created_at:ago(.8),config:configs.s1v2},
    {id:200,device_id:2,device:"CORE-SW-01",version:3,source:"running-config",status:"success",changed:false,hash:"0a34b92d711f",size:566,created_at:ago(7),config:configs.s1v1},
    {id:301,device_id:3,device:"DIST-SW-F2",version:3,source:"running-config",status:"success",changed:false,hash:"11ac9d3f660a",size:482,created_at:ago(2.1),config:configs.d1v1},
    {id:401,device_id:4,device:"EDGE-RTR-01",version:2,source:"running-config",status:"success",changed:false,hash:"6cb713d0a1b8",size:411,created_at:ago(5.4),config:configs.edge1},
    {id:501,device_id:5,device:"BR-SW-01",version:2,source:"running-config",status:"failed",changed:false,hash:"—",size:0,created_at:ago(25),config:"",error:"SSH timeout"},
    {id:500,device_id:5,device:"BR-SW-01",version:1,source:"running-config",status:"success",changed:false,hash:"8c447ab913c1",size:394,created_at:ago(49),config:configs.branch1},
    {id:601,device_id:6,device:"DC-NX-01",version:5,source:"running-config",status:"success",changed:false,hash:"7a90d4ef0021",size:465,created_at:ago(1.2),config:configs.nx1}
  ];

  const audit = [
    {id:1,at:ago(.4),actor:"Backup Engine",action:"Backup completed",detail:"CORE-RTR-01 version 3 stored; configuration change detected.",device_id:1},
    {id:2,at:ago(.8),actor:"Backup Engine",action:"Backup completed",detail:"CORE-SW-01 version 4 stored; VLAN configuration changed.",device_id:2},
    {id:3,at:ago(1.2),actor:"Backup Engine",action:"Backup completed",detail:"DC-NX-01 version 5 stored; no change detected.",device_id:6},
    {id:4,at:ago(2.1),actor:"Backup Engine",action:"Backup completed",detail:"DIST-SW-F2 version 3 stored.",device_id:3},
    {id:5,at:ago(5.4),actor:"Backup Engine",action:"Backup completed",detail:"EDGE-RTR-01 version 2 stored.",device_id:4},
    {id:6,at:ago(25),actor:"Backup Engine",action:"Backup failed",detail:"BR-SW-01 SSH timeout; previous version retained.",device_id:5},
    {id:7,at:ago(40),actor:"Jim Camus",action:"Schedule updated",detail:"CORE-RTR-01 backup interval changed to every 6 hours.",device_id:1}
  ];

  return {generated_at:new Date(now).toISOString(),devices,backups,audit};
})();